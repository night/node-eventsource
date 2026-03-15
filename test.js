const EventSource = require('./eventsource');

const es = new EventSource('http://sse.fastlydemo.net/flights/stream');
es.on('error', (error) => console.log(new Date(), 'Fastly Error: ', error));
es.on('connected', () => console.log(new Date(), 'Fastly Connection Opened'));
es.on('disconnected', () => {
  console.log(new Date(), 'Fastly Connection Closed');
});
es.on('statusChange', (data) => console.log(data));
