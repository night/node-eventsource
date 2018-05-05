# node-eventsource

The official eventsource library has some [reconnect](https://github.com/EventSource/eventsource/issues/57) [bugs](https://github.com/EventSource/eventsource/issues/89) and I've also noticed it fails to detect dropped connections occasionally. This project approaches eventsource with a more modern implementation, and without these bugs.

## Usage

```
const es = new EventSource('https://example.tld/path/to/sse-endpoint');
es.on('connecting', () => console.log('connecting'));
es.on('connected', () => console.log('connected'));
es.on('disconnected', () => console.log('disconnected'));
es.on('some_event_name', ({id, name, data}) => console.log(id, name, data));
```

This library does not take into account `retry` events that set reconnection interval since you can configure backoff with options.

```
new EventSource('https://example.tld/path/to/sse-endpoint', {
  initialReconnectDelay: 2 * 1000, // 2 seconds
  maximumReconnectDelay: 30 * 1000, // 30 seconds
})
```
