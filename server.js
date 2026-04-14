require('dotenv').config();

const express = require('express');
const twilio = require('twilio');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.urlencoded({ extended: false }));
app.use(express.json());

app.get('/', (req, res) => {
  res.send('Realtime Voice Agent V2 is running');
});

app.post('/voice', (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();

  twiml.say('Hello. Thanks for calling. Our voice assistant is currently being set up. Please leave a message after the tone.');

  twiml.pause({ length: 1 });
  twiml.say('Goodbye.');

  res.type('text/xml');
  res.send(twiml.toString());
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});