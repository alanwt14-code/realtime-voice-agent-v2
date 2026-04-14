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
          'You are a friendly dental receptionist. Answer calls naturally and ask how you can help.',
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
    const data = JSON.parse(message.toString());

    if (data.type !== 'response.audio.delta') {
      console.log('OpenAI event:', data.type);
    }

    // 🔊 Send audio back to caller
    if (data.type === 'response.audio.delta' && data.delta && streamSid) {
      twilioWs.send(JSON.stringify({
        event: 'media',
        streamSid,
        media: {
          payload: data.delta
        }
      }));
    }
  });

  twilioWs.on('message', (message) => {
    const data = JSON.parse(message.toString());

    if (data.event !== 'media') {
      console.log('Twilio event:', data.event);
    }

    if (data.event === 'start') {
      streamSid = data.start.streamSid;

      // 🔥 THIS IS THE KEY FIX
      // force OpenAI to speak immediately
      setTimeout(() => {
        if (openaiReady) {
          console.log('Triggering AI greeting');

          openaiWs.send(JSON.stringify({
            type: 'response.create',
            response: {
              modalities: ['audio', 'text'],
              instructions: 'Greet the caller like a dental office receptionist and ask how you can help.'
            }
          }));
        }
      }, 500);
    }

    if (data.event === 'media') {
      if (openaiReady) {
        openaiWs.send(JSON.stringify({
          type: 'input_audio_buffer.append',
          audio: data.media.payload
        }));
      }
    }
  });

  twilioWs.on('close', () => {
    console.log('Call ended');
    openaiWs.close();
  });
});