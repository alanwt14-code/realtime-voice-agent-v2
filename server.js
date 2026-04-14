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
  let greetingSent = false;

  if (!process.env.OPENAI_API_KEY) {
    console.error('Missing OPENAI_API_KEY');
    twilioWs.close();
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

  function sendGreetingIfReady() {
    if (!openaiReady || !streamSid || greetingSent || openaiWs.readyState !== WebSocket.OPEN) {
      return;
    }

    greetingSent = true;

    openaiWs.send(JSON.stringify({
      type: 'conversation.item.create',
      item: {
        type: 'message',
        role: 'user',
        content: [
          {
            type: 'input_text',
            text: 'The caller has just connected. Greet them naturally as the front desk of a dental office and ask how you can help.'
          }
        ]
      }
    }));

    openaiWs.send(JSON.stringify({
      type: 'response.create',
      response: {
        modalities: ['audio', 'text']
      }
    }));
  }

  openaiWs.on('open', () => {
    console.log('Connected to OpenAI Realtime');

    openaiWs.send(JSON.stringify({
      type: 'session.update',
      session: {
        modalities: ['audio', 'text'],
        instructions:
          'You are a warm, natural dental office receptionist answering the phone for a dental practice. Speak like a real human front desk staff member. Be brief, calm, friendly, and professional. Help callers with new patient questions, dental pain, emergencies, scheduling requests, and general office questions. Ask one question at a time. If someone has urgent pain, swelling, bleeding, trauma, or signs of infection, treat it as urgent and gather their name, callback number, and brief issue quickly. Do not say you are an AI unless directly asked. Keep responses short and conversational.',
        voice: 'alloy',
        input_audio_format: 'g711_ulaw',
        output_audio_format: 'g711_ulaw',
        turn_detection: {
          type: 'server_vad',
          threshold: 0.5,
          prefix_padding_ms: 300,
          silence_duration_ms: 500
        }
      }
    }));

    openaiReady = true;
    sendGreetingIfReady();
  });

  openaiWs.on('message', (message) => {
    try {
      const data = JSON.parse(message.toString());

      if (data.type === 'session.created' || data.type === 'session.updated') {
        console.log('OpenAI event:', data.type);
      }

      if (data.type === 'response.audio.delta' && data.delta && streamSid) {
        if (twilioWs.readyState === WebSocket.OPEN) {
          twilioWs.send(JSON.stringify({
            event: 'media',
            streamSid,
            media: {
              payload: data.delta
            }
          }));
        }
      }

      if (data.type === 'response.done') {
        console.log('OpenAI event: response.done');
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
        sendGreetingIfReady();
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

    if (openaiWs.readyState === WebSocket.OPEN || openaiWs.readyState === WebSocket.CONNECTING) {
      openaiWs.close();
    }
  });

  twilioWs.on('error', (err) => {
    console.error('Twilio WebSocket error:', err.message);
  });
});