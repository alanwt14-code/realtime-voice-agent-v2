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
  let callClosed = false;
  let allowCallerAudio = false;

  const openaiWs = new WebSocket(
    'wss://api.openai.com/v1/realtime?model=gpt-realtime',
    {
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        'OpenAI-Beta': 'realtime=v1'
      }
    }
  );

  function safeSendToOpenAI(payload) {
    if (
      !callClosed &&
      openaiWs &&
      openaiWs.readyState === WebSocket.OPEN
    ) {
      openaiWs.send(JSON.stringify(payload));
    }
  }

  function safeSendToTwilio(payload) {
    if (
      !callClosed &&
      twilioWs &&
      twilioWs.readyState === WebSocket.OPEN
    ) {
      twilioWs.send(JSON.stringify(payload));
    }
  }

  function sendGreeting() {
    if (!openaiReady || !streamSid || greetingSent || callClosed) return;

    greetingSent = true;
    console.log('Triggering AI greeting');

    safeSendToOpenAI({
      type: 'response.create',
      response: {
        modalities: ['audio', 'text'],
        instructions:
          'Speak in English only. Say exactly: "Hi, thanks for calling Bright Smile Dental, how can I help you today?" Then stop speaking and wait for the caller to answer.'
      }
    });
  }

  openaiWs.on('open', () => {
    console.log('Connected to OpenAI Realtime');

    safeSendToOpenAI({
      type: 'session.update',
      session: {
        modalities: ['audio', 'text'],
        instructions: `
You are a highly skilled, friendly front desk receptionist for Bright Smile Dental.

You must speak in English only.
Never switch languages.
Never continue in another language.
Do not say "thank you, you're welcome" to yourself or produce filler conversation.

Your job is to handle incoming calls naturally, efficiently, and professionally, like a real human receptionist.

RULES:
- Greet first if the call has just started.
- After the greeting, wait for the caller to speak.
- Do not speak twice in a row unless the caller clearly asked a follow-up.
- Ask only one question at a time.
- Keep responses short and natural.
- Do not repeat information the caller already gave.
- Do not ramble.
- Stay in English only.
- If the caller pauses briefly, do not jump in too fast.
- Do not invent both sides of the conversation.

GOALS:
- understand why the caller is calling
- guide the conversation smoothly
- collect key information
- move toward booking when appropriate

STYLE:
- calm
- warm
- clear
- concise
- human

If the caller mentions pain, swelling, broken tooth, or urgency, respond with empathy and prioritize urgency.

If the caller mentions cleaning, checkup, or general visit, treat it as routine and guide toward scheduling.

If the caller mentions cosmetic or major work, guide them toward a consultation.

Only ask for missing information when needed:
- name
- callback number
- issue
- preferred time

At the end, confirm key details clearly.
        `,
        voice: 'alloy',
        input_audio_format: 'g711_ulaw',
        output_audio_format: 'g711_ulaw',
        turn_detection: {
          type: 'server_vad',
          threshold: 0.6,
          prefix_padding_ms: 300,
          silence_duration_ms: 900
        }
      }
    });

    openaiReady = true;
    sendGreeting();
  });

  openaiWs.on('message', (message) => {
    try {
      const data = JSON.parse(message.toString());

      if (data.type !== 'response.audio.delta') {
        console.log('OpenAI event:', data.type);
      }

      if (data.type === 'response.audio.delta' && data.delta && streamSid) {
        safeSendToTwilio({
          event: 'media',
          streamSid,
          media: {
            payload: data.delta
          }
        });
      }

      if (data.type === 'response.done') {
        if (!allowCallerAudio && greetingSent) {
          console.log('Greeting finished, caller audio now allowed');
          allowCallerAudio = true;
        }
      }
    } catch (error) {
      console.error('Error parsing OpenAI message:', error.message);
    }
  });

  twilioWs.on('message', (message) => {
    try {
      const data = JSON.parse(message.toString());

      if (data.event !== 'media') {
        console.log('Twilio event:', data.event);
      }

      if (data.event === 'start') {
        streamSid = data.start.streamSid;
        sendGreeting();
      }

      if (data.event === 'media') {
        if (openaiReady && allowCallerAudio) {
          safeSendToOpenAI({
            type: 'input_audio_buffer.append',
            audio: data.media.payload
          });
        }
      }

      if (data.event === 'stop') {
        console.log('Twilio stream stopped');
      }
    } catch (error) {
      console.error('Error parsing Twilio message:', error.message);
    }
  });

  twilioWs.on('close', () => {
    callClosed = true;
    console.log('Call ended');

    if (
      openaiWs &&
      (openaiWs.readyState === WebSocket.OPEN ||
        openaiWs.readyState === WebSocket.CONNECTING)
    ) {
      openaiWs.close();
    }
  });

  openaiWs.on('close', () => {
    console.log('OpenAI connection closed');
  });

  openaiWs.on('error', (error) => {
    console.error('OpenAI error:', error.message);
  });

  twilioWs.on('error', (error) => {
    console.error('Twilio error:', error.message);
  });
});