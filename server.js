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
  let assistantSpeaking = false;
  let callerHasStartedSpeaking = false;

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

  function createAssistantResponse(instructionsText) {
    if (callClosed) return;

    assistantSpeaking = true;
    callerHasStartedSpeaking = false;

    safeSendToOpenAI({
      type: 'response.create',
      response: {
        modalities: ['audio', 'text'],
        instructions: instructionsText
      }
    });
  }

  function sendGreeting() {
    if (!openaiReady || !streamSid || greetingSent || callClosed) return;

    greetingSent = true;
    console.log('Triggering AI greeting');

    createAssistantResponse(
      'Speak in English only. Say exactly: "Hi, thanks for calling Bright Smile Dental, how can I help you today?" Then stop speaking and wait for the caller to answer. Do not continue until the caller speaks.'
    );
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
Never invent the caller's side of the conversation.
Never continue talking if the caller has not answered yet.

Your job is to handle incoming calls naturally, efficiently, and professionally.

CORE GOAL:
Help the caller, collect the right information, and move toward booking smoothly.

REQUIRED FLOW:
1. Greet the caller first.
2. Wait for the caller to explain why they are calling.
3. Understand their issue first.
4. After you understand their issue, collect:
   - full name
   - best callback phone number
5. Only after you have the issue, full name, and phone number, move to booking.
6. When offering appointment times, offer one or two options and then STOP TALKING.
7. Always wait for the caller's answer before continuing.
8. Confirm the appointment details clearly at the end.

STYLE:
- warm
- calm
- human
- concise
- professional
- one question at a time
- short responses
- no rambling
- no repetition unless the caller was unclear

RULES:
- ask only one question at a time
- do not ask for full name or phone number before you understand their issue
- do not move into booking before you have:
  issue + full name + phone number
- after asking whether a time works, wait for the caller's answer
- do not ask another question until the caller responds
- if the caller pauses briefly, wait rather than jumping in
- do not say random filler like "sure" or "you're welcome" unless it directly fits the conversation
- do not diagnose medical conditions

IF THE ISSUE IS URGENT:
If they mention pain, swelling, broken tooth, bleeding, infection, or trauma, respond with empathy and urgency.

BOOKING STYLE:
When it is time to book, guide the caller with one or two time options.
Example:
"I have something tomorrow at 10:00 AM or Thursday at 2:30 PM. Which works better for you?"
Then wait for the caller's answer before saying anything else.

IMPORTANT:
After every question, wait for the caller's answer.
Do not continue the script on your own.
        `,
        voice: 'alloy',
        input_audio_format: 'g711_ulaw',
        output_audio_format: 'g711_ulaw',
        turn_detection: {
          type: 'server_vad',
          threshold: 0.75,
          prefix_padding_ms: 300,
          silence_duration_ms: 1100,
          create_response: false,
          interrupt_response: true
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
        assistantSpeaking = false;
        console.log('Assistant finished speaking');
      }

      if (data.type === 'input_audio_buffer.speech_started') {
        if (!assistantSpeaking) {
          callerHasStartedSpeaking = true;
          console.log('Caller started speaking');
        }
      }

      if (data.type === 'input_audio_buffer.speech_stopped') {
        console.log('Caller stopped speaking');

        // ONLY respond if there was a real caller speech start first
        if (!assistantSpeaking && callerHasStartedSpeaking) {
          createAssistantResponse(
            'Respond in English only as the dental office receptionist. Continue naturally from the caller’s last message. If you do not yet know their issue, ask about it. If you know their issue but do not yet have their full name, ask for their full name. If you have their issue and full name but not their phone number, ask for their best callback phone number. Only after you have the issue, full name, and phone number should you move to booking. If you offer appointment times, stop speaking afterward and wait for the caller’s answer.'
          );
        }
      }

      if (data.type === 'error') {
        console.error('OpenAI error:', JSON.stringify(data, null, 2));
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
        safeSendToOpenAI({
          type: 'input_audio_buffer.append',
          audio: data.media.payload
        });
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