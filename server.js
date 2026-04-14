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

// Twilio webhook → start streaming
app.post('/voice', (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();

  twiml.connect().stream({
    url: `wss://${req.headers.host}/ws`
  });

  res.type('text/xml');
  res.send(twiml.toString());
});

// Start server
const server = app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

// WebSocket server
const wss = new WebSocket.Server({ server });

wss.on('connection', (ws) => {
  console.log('Twilio connected');

  let openaiWs;

  // Connect to OpenAI Realtime
  openaiWs = new WebSocket('wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview', {
    headers: {
      "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
      "OpenAI-Beta": "realtime=v1"
    }
  });

  openaiWs.on('open', () => {
    console.log('Connected to OpenAI');

    // Tell OpenAI how to behave
    openaiWs.send(JSON.stringify({
      type: "session.update",
      session: {
        instructions: "You are a friendly dental office receptionist. Speak naturally and help callers book appointments or describe their issue.",
        voice: "alloy",
        input_audio_format: "g711_ulaw",
        output_audio_format: "g711_ulaw"
      }
    }));
  });

  ws.on('message', (message) => {
    const data = JSON.parse(message);

    // Only log important events
    if (data.event !== 'media') {
      console.log('Twilio event:', data.event);
    }

    // Send audio from Twilio → OpenAI
    if (data.event === 'media') {
      openaiWs.send(JSON.stringify({
        type: "input_audio_buffer.append",
        audio: data.media.payload
      }));
    }
  });

  // Receive audio from OpenAI → send back to Twilio
  openaiWs.on('message', (msg) => {
    const response = JSON.parse(msg);

    if (response.type === 'response.audio.delta') {
      ws.send(JSON.stringify({
        event: 'media',
        media: {
          payload: response.delta
        }
      }));
    }
  });

  ws.on('close', () => {
    console.log('Call ended');
    openaiWs.close();
  });
});