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
  let greetingFinished = false;
  let allowCallerAudio = false;
  let callClosed = false;

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
    if (!callClosed && openaiWs.readyState === WebSocket.OPEN) {
      openaiWs.send(JSON.stringify(payload));
    }
  }

  function safeSendToTwilio(payload) {
    if (!callClosed && twilioWs.readyState === WebSocket.OPEN) {
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
          'Speak in English only. Say exactly: "Hi, thanks for calling Bright Smile Dental, how can I help you today?" Then stop speaking and wait for the caller to answer. Do not continue talking unless the caller speaks first.'
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
Do not invent both sides of the conversation.
Do not answer for the caller.
Do not continue talking after your greeting unless the caller actually speaks first.

Your job is to handle incoming calls naturally, efficiently, and professionally.

RULES:
- greet first
- after the greeting, wait for the caller
- ask one question at a time
- keep responses short
- do not ramble
- do not repeat information the caller already gave
- do not jump in too quickly if the caller pauses briefly
- do not say random filler like "sure" or "you're welcome" unless it truly fits the caller's words

STYLE:
- warm
- calm
- clear
- concise
- human

If the caller mentions pain, swelling, broken tooth, or urgency, respond with empathy and prioritize urgency.

If the caller mentions cleaning, checkup, or general visit, treat it as routine and guide toward scheduling.

Only ask for missing information when needed:
- name
- callback number
- issue
- preferred time
        `,
        voice: 'alloy',
        input_audio_format: 'g711_ulaw',
        output_audio_format: 'g711_ulaw',
        turn_detection: {
          type: 'server_vad',
          threshold: 0.7,
          prefix_padding_ms: 300,
          silence_duration_ms: 1200
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

      if (data.type === 'response.done' && greetingSent && !greetingFinished) {
        greetingFinished = true;
        console.log('Greeting finished');

        safeSendToOpenAI({
          type: 'input_audio_buffer.clear'
        });

        setTimeout(() => {
          allowCallerAudio = true;
          console.log('Caller audio now allowed');
        }, 1200);
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
      openaiWs.readyState === WebSocket.OPEN ||
      openaiWs.readyState === WebSocket.CONNECTING
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