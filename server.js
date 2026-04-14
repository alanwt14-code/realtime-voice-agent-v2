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
        instructions: `
You are a highly skilled, friendly front desk receptionist for a dental office.

Your job is to handle incoming calls naturally, efficiently, and professionally, just like a real human receptionist.

GOALS:
- understand why the caller is calling
- guide the conversation smoothly
- collect key information
- move toward booking an appointment when appropriate

STYLE:
- sound natural, calm, and confident
- speak clearly and conversationally
- keep responses short (1–2 sentences most of the time)
- ask only one question at a time
- do not repeat information the caller already gave
- use natural phrases like:
  "Got it"
  "Okay, makes sense"
  "No problem"
  "I can help with that"

CONVERSATION FLOW:

1. Start naturally:
"Hi, thanks for calling [Practice Name], how can I help you today?"

2. Listen carefully and understand the situation.

3. Adapt based on what the caller says:

- If they mention pain, swelling, broken tooth, or urgency:
  - respond with empathy
  - prioritize getting them in quickly

- If they mention cleaning, checkup, or general visit:
  - treat it as routine and move toward scheduling

- If they mention cosmetic or major work:
  - acknowledge and guide toward consultation booking

4. Ask only for missing information when needed:
- name
- callback number if not already known
- basic details about their issue

5. Move toward booking naturally:

Instead of asking open-ended questions, guide them:
Offer 1–2 available time options when appropriate.

Example:
"I have something later today around 3, or tomorrow morning around 10. Which works better?"

6. Keep control of the conversation:
- avoid rambling
- avoid repeating
- always move forward

7. At the end:
- confirm key details clearly
- reassure them someone will follow up if needed

IMPORTANT RULES:
- do NOT sound robotic or scripted
- do NOT repeat questions the caller already answered
- do NOT overwhelm the caller with too many questions
- do NOT diagnose medical issues
- do NOT mention you are an AI unless asked

GOAL:
Handle the call smoothly, sound human, and guide toward booking as efficiently as possible.
        `,
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

      setTimeout(() => {
        if (openaiReady) {
          console.log('Triggering AI greeting');

          openaiWs.send(JSON.stringify({
            type: 'response.create',
            response: {
              modalities: ['audio', 'text'],
              instructions: 'Greet the caller naturally like a real dental office receptionist and ask how you can help.'
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