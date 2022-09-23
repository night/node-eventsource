const EventEmitter = require('events').EventEmitter;
const undici = require('undici');
const backoff = require('backoff');
const {Writable} = require('stream');

const ReadyStates = {
  CONNECTING: 0,
  CONNECTED: 1,
  DISCONNECTED: 2,
};

const COLON_CHARACTER = 58;
const SPACE_CHARACTER = 32;
const LINE_FEED_CHARACTER = 10;
const CARRIAGE_RETURN_CHARACTER = 13;

const DefaultOptions = {
  initialReconnectDelay: 2 * 1000,
  maximumReconnectDelay: 30 * 1000,
  heartbeatTimeout: 30 * 1000,
};

class EventSource extends EventEmitter {
  constructor(url, options = {}) {
    super();

    this.options = {...DefaultOptions, ...options};
    this.url = url;
    this.readyState = ReadyStates.DISCONNECTED;
    this.lastEventId = null;
    this.heartbeatTimeout = null;

    this.backoff = backoff.exponential({
      initialDelay: this.options.initialReconnectDelay,
      maxDelay: this.options.maximumReconnectDelay,
    });
    this.backoff.on('ready', () => this.connect());

    this.connect();
  }

  async connect() {
    if ([ReadyStates.CONNECTING, ReadyStates.CONNECTED].includes(this.readyState)) return;
    this.readyState = ReadyStates.CONNECTING;
    this.emit('connecting');

    const headers = {};
    if (this.lastEventId) {
      headers['Last-Event-ID'] = this.lastEventId;
    }

    try {
      await undici.stream(this.url, {headers}, (response) => this.handleResponse(response));
    } catch (err) {
      this.emit('error', err);
    }

    this.emit('disconnected');
    this.readyState = ReadyStates.DISCONNECTED;
    try {
      this.backoff.backoff();
    } catch (_) {}
  }

  resetHeartbeatTimeout(callback) {
    if (this.heartbeatInterval != null) return;
    this.heartbeatInterval = setInterval(() => {
      if (this.lastHeartbeat > Date.now() - this.options.heartbeatTimeout) {
        return;
      }
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
      callback(new Error(`no heartbeat from server in ${this.options.heartbeatTimeout}ms`));
    }, this.options.heartbeatTimeout);

    return () => {
      this.lastHeartbeat = Date.now();
    };
  }

  handleResponse({statusCode, headers}) {
    if (statusCode !== 200) {
      throw new Error(`response not OK. status code: ${statusCode}`);
    }

    const contentType = headers['content-type'];
    if (!contentType.includes('text/event-stream')) {
      throw new Error(`response content type not text/event-stream: ${contentType}`);
    }

    let eventId = null;
    let eventName = '';
    let eventData = '';
    const parseEventStreamLine = (buffer, position, fieldLength, lineLength) => {
      if (lineLength === 0) {
        if (eventData.length > 0) {
          this.emit(eventName || 'message', {
            id: eventId,
            name: eventName,
            data: eventData.slice(0, -1), // trim trailing new line
          });
          eventData = '';
        }
        if (eventId != null) {
          this.lastEventId = eventId;
          eventId = null;
        }
        eventName = null;
      } else if (fieldLength > 0) {
        const emptyValue = fieldLength < 0;
        let step = 0;
        const field = buffer.slice(position, position + (emptyValue ? lineLength : fieldLength)).toString();

        if (emptyValue) {
          step = lineLength;
        } else if (buffer[position + fieldLength + 1] !== SPACE_CHARACTER) {
          step = fieldLength + 1;
        } else {
          step = fieldLength + 2;
        }
        position += step;

        const valueLength = lineLength - step;
        const value = buffer.slice(position, position + valueLength).toString();

        if (field === 'data') {
          eventData += value + '\n';
        } else if (field === 'event') {
          eventName = value;
        } else if (field === 'id') {
          eventId = value;
        }
      }
    }

    let heartbeat;
    let buffer;
    let discardTrailingNewline = false;

    const writable = new Writable({
      write(chunk, encoding, callback) {
        buffer = buffer != null ? Buffer.concat([buffer, chunk]) : chunk;

        let position = 0;
        let bufferLength = buffer.length;

        while (position < bufferLength) {
          if (discardTrailingNewline) {
            if (buffer[position] === LINE_FEED_CHARACTER) {
              ++position;
            }
            discardTrailingNewline = false;
          }

          let lineLength = -1;
          let fieldLength = -1;

          for (let bufferIndex = position; lineLength < 0 && bufferIndex < bufferLength; ++bufferIndex) {
            const character = buffer[bufferIndex];
            if (character === COLON_CHARACTER) {
              if (fieldLength < 0) {
                fieldLength = bufferIndex - position;
              }
            } else if (character === CARRIAGE_RETURN_CHARACTER) {
              discardTrailingNewline = true;
              lineLength = bufferIndex - position;
            } else if (character === LINE_FEED_CHARACTER) {
              lineLength = bufferIndex - position;
            }
          }

          if (lineLength < 0) {
            break;
          }

          parseEventStreamLine(buffer, position, fieldLength, lineLength);

          position += lineLength + 1;
        }

        if (position === bufferLength) {
          buffer = null;
        } else if (position > 0) {
          buffer = buffer.slice(position);
        }

        heartbeat?.();

        callback();
      },
    });

    this.backoff.reset();
    heartbeat = this.resetHeartbeatTimeout((err) => writable.destroy(err));
    this.readyState = ReadyStates.CONNECTED;
    this.emit('connected');

    return writable;
  }
}

module.exports = EventSource;
