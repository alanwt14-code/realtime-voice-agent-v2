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
        instructions: `
You are a highly skilled, friendly front desk receptionist for a dental office.

You must speak in English only.
Never switch languages.
Never greet in another language.
Never continue in another language unless the caller very clearly asks you to, but for this demo stay in English only.

Your job is to handle incoming calls naturally, efficiently, and professionally, just like a real human receptionist.

GOALS:
- greet the caller first
- then pause and wait for the caller to speak
- understand why the caller is calling
- guide the conversation smoothly
- collect key information
- move toward booking an appointment when appropriate

STYLE:
- sound natural, calm, confident, and human
- speak clearly and conversationally
- keep responses short
- ask only one question at a time
- do not interrupt the caller
- after your greeting, wait for the caller to answer before asking anything else
- do not repeat information the caller already gave
- do not ramble
- do not switch languages
- stay in English only

GOOD PHRASES:
- "Got it"
- "Okay, I can help with that"
- "No problem"
- "Okay, that makes sense"

CONVERSATION FLOW:
1. Start with one short greeting in English only:
   "Hi, thanks for calling [Practice Name], how can I help you today?"
2. Then stop and wait for the caller to respond.
3. Listen carefully and adapt naturally.
4. If they mention pain, swelling, broken tooth, or urgency, respond with empathy and prioritize getting them in quickly.
5. If they mention cleaning, checkup, or general visit, treat it as routine and move toward scheduling.
6. If they mention cosmetic or major work, acknowledge that and guide toward a consultation.
7. Ask only for missing information when needed:
   - name
   - callback number
   - basic details about the issue
8. Confirm key details clearly at the end.

IMPORTANT RULES:
- English only
- greet first, then wait
- do not speak twice in a row before the caller answers
- do not sound robotic or scripted
- do not diagnose medical issues
- do not mention you are an AI unless asked

GOAL:
Handle the call smoothly, sound human, stay in English, and guide toward booking efficiently.
        `,
        voice: 'alloy',
        input_audio_format: 'g711_ulaw',
        output_audio_format: 'g711_ulaw',
        turn_detection: {
          type: 'server_vad',
          threshold: 0.5,
          prefix_padding_ms: 300,
          silence_duration_ms: 700
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

      if (!greetingSent) {
        greetingSent = true;

        setTimeout(() => {
          if (openaiReady) {
            console.log('Triggering AI greeting');

            openaiWs.send(JSON.stringify({
              type: 'response.create',
              response: {
                modalities: ['audio', 'text'],
                instructions: 'In English only, say: "Hi, thanks for calling [Practice Name], how can I help you today?" Then stop speaking and wait for the caller to answer.'
              }
            }));
          }
        }, 500);
      }
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