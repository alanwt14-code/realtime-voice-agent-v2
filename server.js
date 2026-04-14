require('dotenv').config();

const express = require('express');
const twilio = require('twilio');
const WebSocket = require('ws');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.urlencoded({ extended: false }));
app.use(express.json());

app.get('/', (req, res) => {
  res.send('Realtime Voice Agent V2 is running');
});

app.post('/voice', (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();

  twiml.connect().stream({
    url: `wss://${req.headers.host}/ws`
  });

  res.type('text/xml');
  res.send(twiml.toString());
});

const server = app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

const wss = new WebSocket.Server({ server });

wss.on('connection', (twilioWs) => {
  console.log('Twilio connected');

  let streamSid = null;
  let openaiReady = false;

  if (!process.env.OPENAI_API_KEY) {
    console.error('Missing OPENAI_API_KEY');
    return;
  }

  const openaiWs = new WebSocket(
    'wss://api.openai.com/v1/realtime?model=gpt-realtime',
    {
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        'OpenAI-Beta': 'realtime=v1'
      }
    }
  );

  openaiWs.on('open', () => {
    console.log('Connected to OpenAI Realtime');

    openaiWs.send(JSON.stringify({
      type: 'session.update',
      session: {
        modalities: ['audio', 'text'],
        instructions:
          'You are a friendly dental office receptionist. Greet the caller naturally and ask how you can help. Keep responses short and warm.',
        voice: 'alloy',
        input_audio_format: 'g711_ulaw',
        output_audio_format: 'g711_ulaw',
        turn_detection: {
          type: 'server_vad'
        }
      }
    }));

    openaiReady = true;
  });

  openaiWs.on('message', (message) => {
    try {
      const data = JSON.parse(message.toString());

      if (data.type !== 'response.audio.delta') {
        console.log('OpenAI event:', data.type);
      }

      if (data.type === 'response.audio.delta' && data.delta && streamSid) {
        twilioWs.send(JSON.stringify({
          event: 'media',
          streamSid,
          media: {
            payload: data.delta
          }
        }));
      }

      if (data.type === 'error') {
        console.error('OpenAI error:', JSON.stringify(data, null, 2));
      }
    } catch (err) {
      console.error('Error parsing OpenAI message:', err.message);
    }
  });

  openaiWs.on('close', () => {
    console.log('OpenAI connection closed');
  });

  openaiWs.on('error', (err) => {
    console.error('OpenAI WebSocket error:', err.message);
  });

  twilioWs.on('message', (message) => {
    try {
      const data = JSON.parse(message.toString());

      if (data.event !== 'media') {
        console.log('Twilio event:', data.event);
      }

      if (data.event === 'start') {
        streamSid = data.start.streamSid;

        if (openaiReady && openaiWs.readyState === WebSocket.OPEN) {
          console.log('Sending initial greeting request to OpenAI');

          openaiWs.send(JSON.stringify({
            type: 'response.create',
            response: {
              modalities: ['audio', 'text'],
              instructions: 'Greet the caller naturally as a dental office receptionist and ask how you can help.'
            }
          }));
        }
      }

      if (data.event === 'media') {
        if (openaiReady && openaiWs.readyState === WebSocket.OPEN) {
          openaiWs.send(JSON.stringify({
            type: 'input_audio_buffer.append',
            audio: data.media.payload
          }));
        }
      }

      if (data.event === 'stop') {
        console.log('Twilio stream stopped');
      }
    } catch (err) {
      console.error('Error parsing Twilio message:', err.message);
    }
  });

  twilioWs.on('close', () => {
    console.log('Twilio WebSocket closed');

    if (
      openaiWs.readyState === WebSocket.OPEN ||
      openaiWs.readyState === WebSocket.CONNECTING
    ) {
      openaiWs.close();
    }
  });

  twilioWs.on('error', (err) => {
    console.error('Twilio WebSocket error:', err.message);
  });
});