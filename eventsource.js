const EventEmitter = require('events').EventEmitter;
const fetch = require('node-fetch');
const backoff = require('backoff');

const EVENT_ENDING_REGEX = /(?:\r|\n|\r\n)(?:\r|\n|\r\n)/;
const LINE_ENDING_REGEX = /(?:\r|\n|\r\n)/;

const ReadyStates = {
    CONNECTING: 0,
    CONNECTED: 1,
    DISCONNECTED: 2,
};

const DefaultOptions = {
    initialReconnectDelay: 2 * 1000,
    maximumReconnectDelay: 30 * 1000,
    heartbeatTimeout: 30 * 1000,
};

class EventSourceEvent {
    constructor(data) {
        let eventId = null;
        let eventName = '';
        let eventData = '';

        const lines = data.split(LINE_ENDING_REGEX);
        for (const line of lines) {
            if (line.startsWith(':')) continue;

            const colonIndex = line.indexOf(':');
            let fieldName = '';
            let fieldValue = '';
            if (colonIndex > -1) {
                fieldName = line.substr(0, colonIndex);
                fieldValue = line.substr(colonIndex + 1);
                if (fieldValue.startsWith(' ')) {
                    fieldValue = fieldValue.substr(1);
                }
            } else {
                fieldName = line;
                fieldValue = '';
            }

            switch (fieldName) {
                case 'event':
                    eventName = fieldValue;
                    break;
                case 'data':
                    eventData += fieldValue + '\n';
                    break;
                case 'id':
                    if (!fieldValue.includes('\0')) {
                        eventId = fieldValue;
                    }
                    break;
            }
        }

        this.id = eventId;
        this.name = eventName || 'message';
        this.data = eventData;
    }

    get empty() {
        return !this.data;
    }
}

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

    connect() {
        if ([ReadyStates.CONNECTING, ReadyStates.CONNECTED].includes(this.readyState)) return;
        this.readyState = ReadyStates.CONNECTING;
        this.emit('connecting');

        const headers = {};
        if (this.lastEventId) {
            headers['Last-Event-ID'] = this.lastEventId;
        }

        fetch(this.url, {headers})
        .then(response => this.handleResponse(response))
        .catch(err => this.emit('error', err))
        .then(() => {
            this.emit('disconnected');
            this.readyState = ReadyStates.DISCONNECTED;
            try {
                this.backoff.backoff();
            } catch (_) {}
        });
    }

    resetHeartbeatTimeout(callback) {
        if (this.heartbeatTimeout) {
            clearTimeout(this.heartbeatTimeout);
        }
        this.heartbeatTimeout = setTimeout(
            () => callback(new Error(`no heartbeat from server in ${this.options.heartbeatTimeout}ms`)),
            this.options.heartbeatTimeout
        );
    }

    handleResponse(response) {
        return new Promise((resolve, reject) => {
            if (!response.ok) {
                response
                    .text()
                    .then(body => reject(new Error(`response not OK. status code: ${response.status} body: ${body}`)));
                return;
            }

            const contentType = response.headers.get('Content-Type');
            if (!contentType.includes('text/event-stream')) {
                reject(new Error(`response content type not text/event-stream: ${contentType}`));
                return;
            }

            response.body.on('error', err => reject(new Error(`error when reading from response: ${err.message}`)));
            response.body.on('end', () => resolve());

            let buffer = '';
            response.body.on('data', chunk => {
                this.resetHeartbeatTimeout(err => response.body.destroy(err));

                buffer += chunk.toString('utf8');

                const bufferedEvents = buffer.split(EVENT_ENDING_REGEX);
                if (bufferedEvents.length < 2) return;

                for (let i = 0; i < bufferedEvents.length - 1; i++) {
                    const bufferedEvent = bufferedEvents[i];
                    if (!bufferedEvent.length) continue;

                    const event = new EventSourceEvent(bufferedEvent);
                    if (!event.empty) this.emit(event.name, event);
                    if (event.id) this.lastEventId = event.id;
                }

                buffer = '';
            });

            this.backoff.reset();
            this.readyState = ReadyStates.CONNECTED;
            this.emit('connected');
        });
    }
}

module.exports = EventSource;
