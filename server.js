require('dotenv').config();

const express = require('express');
const twilio = require('twilio');
const WebSocket = require('ws');
const { google } = require('googleapis');

// ─────────────────────────────────────────────────────────────────────────────
// ENV VARIABLES NEEDED:
//
//   TWILIO_ACCOUNT_SID
//   TWILIO_AUTH_TOKEN
//   TWILIO_PHONE_NUMBER        ← your Twilio number (SMS "from")
//   OWNER_PHONE                ← your personal cell (receives owner summary SMS)
//   OPENAI_API_KEY
//
//   GOOGLE_SERVICE_ACCOUNT_EMAIL
//   GOOGLE_PRIVATE_KEY
//   GOOGLE_CALENDAR_ID
//   GOOGLE_SHEET_ID            ← the ID from your Google Sheet URL
//
//   TZ=America/New_York        ← set in Railway variables
//
// DEMO MODE:
//   Set OWNER_PHONE to your personal number. Both the owner summary SMS and
//   the customer confirmation SMS will go to that number so you can show
//   both texts live during a demo.
//   When going to production, change sendCustomerConfirmationText() so
//   `to: OWNER_PHONE` becomes `to: phone`.
//
// See bottom of file for full Google Calendar + Sheets setup guide.
// ─────────────────────────────────────────────────────────────────────────────

const app = express();
const PORT       = process.env.PORT || 3000;
const CALENDAR_ID = process.env.GOOGLE_CALENDAR_ID || 'primary';
const SHEET_ID    = process.env.GOOGLE_SHEET_ID    || '';

const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
const TWILIO_PHONE = process.env.TWILIO_PHONE_NUMBER || '';
const OWNER_PHONE  = process.env.OWNER_PHONE || TWILIO_PHONE; // fallback if OWNER_PHONE not set

app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// ─────────────────────────────────────────────────────────────────────────────
// Google Auth — single JWT used for both Calendar and Sheets
// ─────────────────────────────────────────────────────────────────────────────
const googleAuth = new google.auth.JWT({
  email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
  key:   process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
  scopes: [
    'https://www.googleapis.com/auth/calendar',
    'https://www.googleapis.com/auth/spreadsheets',
  ],
});

const calendarClient = google.calendar({ version: 'v3', auth: googleAuth });
const sheetsClient   = google.sheets({   version: 'v4', auth: googleAuth });

// ─────────────────────────────────────────────────────────────────────────────
// Business hours
// Keys: 0=Sun, 1=Mon, 2=Tue, 3=Wed, 4=Thu, 5=Fri, 6=Sat   null = closed
// ─────────────────────────────────────────────────────────────────────────────
const BUSINESS_HOURS = {
  0: null,
  1: { open: 7, close: 16 },
  2: { open: 7, close: 16 },
  3: { open: 7, close: 16 },
  4: { open: 7, close: 16 },
  5: { open: 7, close: 16 },
  6: { open: 9, close: 14 },
};

// ─────────────────────────────────────────────────────────────────────────────
// Google Sheets — log every booking as a new row
//
// Columns:  A=Timestamp  B=Patient Name  C=Phone  D=Reason
//           E=Category   F=Patient Type  G=Appointment Date & Time
// ─────────────────────────────────────────────────────────────────────────────
async function logToSheet({ name, phone, reason, category, patientType, datetime }) {
  console.log(`logToSheet — SHEET_ID=${SHEET_ID || 'NOT SET'}`);
  if (!SHEET_ID) {
    console.warn('GOOGLE_SHEET_ID not set — skipping sheet log');
    return;
  }

  const tz = process.env.TZ || 'America/New_York';

  const timestamp = new Date().toLocaleString('en-US', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: 'numeric', minute: '2-digit', hour12: true,
  });

  const apptDate = new Date(datetime).toLocaleString('en-US', {
    timeZone: tz, weekday: 'short', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: true,
  });

  const categoryLabels = { emergency: 'Emergency', high_value: 'High Value', routine: 'Routine' };

  const row = [
    timestamp,
    name,
    phone,
    reason,
    categoryLabels[category] || category,
    patientType === 'new' ? 'New' : 'Existing',
    apptDate,
  ];

  try {
    await sheetsClient.spreadsheets.values.append({
      spreadsheetId:    SHEET_ID,
      range:            'Sheet1!A:G',
      valueInputOption: 'USER_ENTERED',
      requestBody:      { values: [row] },
    });
    console.log('Lead logged to Google Sheet');
  } catch (err) {
    console.error('Google Sheets log failed:', err.message); // non-fatal
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SMS helpers
// ─────────────────────────────────────────────────────────────────────────────

const NEW_PATIENT_BRING_LIST = [
  '• Photo ID',
  '• Insurance card / insurance info',
  '• List of current medications',
  '• Any previous dental records',
  '• Arrive 15 min early for new patient paperwork',
].join('\n');

/**
 * Owner summary SMS — sent to OWNER_PHONE (your personal number in demo mode).
 */
async function sendOwnerSummaryText({ name, phone, reason, category, patientType, datetime, durationMinutes }) {
  console.log(`sendOwnerSummaryText — TWILIO_PHONE=${TWILIO_PHONE || 'NOT SET'} OWNER_PHONE=${OWNER_PHONE || 'NOT SET'}`);
  if (!TWILIO_PHONE || !OWNER_PHONE) {
    console.warn('TWILIO_PHONE or OWNER_PHONE not set — skipping owner SMS');
    return;
  }

  const dateStr = new Date(datetime).toLocaleString('en-US', {
    timeZone: process.env.TZ || 'America/New_York',
    weekday: 'short', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: true,
  });

  const categoryLabels = { emergency: '🚨 EMERGENCY', high_value: '⭐ HIGH VALUE', routine: '📋 ROUTINE' };

  const body = [
    `📞 New Lead — Bright Smile Dental`,
    ``,
    `${categoryLabels[category] || category}`,
    `Patient: ${name}`,
    `Type:    ${patientType === 'new' ? 'New patient' : 'Existing patient'}`,
    `Reason:  ${reason}`,
    `Appt:    ${dateStr} (${durationMinutes} min)`,
    `Phone:   ${phone}`,
  ].join('\n');

  try {
    await twilioClient.messages.create({ body, from: TWILIO_PHONE, to: OWNER_PHONE });
    console.log(`Owner summary SMS sent to ${OWNER_PHONE}`);
  } catch (err) {
    console.error('Owner SMS failed:', err.message); // non-fatal
  }
}

/**
 * Customer confirmation SMS.
 *
 * DEMO MODE:   `to: OWNER_PHONE`  — both texts land on your phone.
 * PRODUCTION:  change to `to: phone` to send to the real caller.
 *
 * New patients also receive the "what to bring" list.
 */
async function sendCustomerConfirmationText({ name, phone, reason, patientType, datetime, durationMinutes }) {
  console.log(`sendCustomerConfirmationText — TWILIO_PHONE=${TWILIO_PHONE || 'NOT SET'} OWNER_PHONE=${OWNER_PHONE || 'NOT SET'}`);
  if (!TWILIO_PHONE) {
    console.warn('TWILIO_PHONE not set — skipping customer SMS');
    return;
  }

  const dateStr = new Date(datetime).toLocaleString('en-US', {
    timeZone: process.env.TZ || 'America/New_York',
    weekday: 'long', month: 'long', day: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: true,
  });

  const firstName = name.split(' ')[0];

  const lines = [
    `Hi ${firstName}! This is Bright Smile Dental confirming your appointment.`,
    ``,
    `📅 ${reason}`,
    `🕐 ${dateStr} (${durationMinutes} min)`,
    ``,
    `Questions? Call us back at this number.`,
  ];

  if (patientType === 'new') {
    lines.push('');
    lines.push(`Since you're a new patient, please remember to bring:`);
    lines.push(NEW_PATIENT_BRING_LIST);
  }

  lines.push('');
  lines.push(`— Bright Smile Dental`);

  try {
    // DEMO MODE: routes to OWNER_PHONE so you see both texts on one device.
    // PRODUCTION: replace `OWNER_PHONE` with `phone` to text the real caller.
    await twilioClient.messages.create({ body: lines.join('\n'), from: TWILIO_PHONE, to: OWNER_PHONE });
    console.log(`Customer confirmation SMS sent to ${OWNER_PHONE} (demo mode)`);
  } catch (err) {
    console.error('Customer SMS failed:', err.message); // non-fatal
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Date helpers
// ─────────────────────────────────────────────────────────────────────────────
function snapToNext30(date) {
  const m = date.getMinutes();
  if (m === 0) return;
  if (m <= 30) date.setMinutes(30, 0, 0);
  else date.setHours(date.getHours() + 1, 0, 0, 0);
}

function advanceToNextBusinessOpen(date) {
  date.setDate(date.getDate() + 1);
  for (let i = 0; i < 7; i++) {
    const h = BUSINESS_HOURS[date.getDay()];
    if (h) { date.setHours(h.open, 0, 0, 0); return; }
    date.setDate(date.getDate() + 1);
  }
}

function formatSlotForSpeech(date) {
  const now      = new Date();
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const timeStr  = date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
  if (date.toDateString() === now.toDateString())      return `today at ${timeStr}`;
  if (date.toDateString() === tomorrow.toDateString()) return `tomorrow at ${timeStr}`;
  return `${date.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })} at ${timeStr}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Availability logic
// ─────────────────────────────────────────────────────────────────────────────
async function getAvailableSlots(category, patientType, reason, timePreference = 'any', daysOffset = 0) {
  const durationMinutes = 60;
  const maxOptions      = 2;

  let searchHours;
  if (category === 'emergency')       searchHours = 48;
  else if (category === 'high_value') searchHours = 5 * 24;
  else                                searchHours = 28 * 24;

  const now = new Date();

  let searchStart = new Date(now);
  if (daysOffset > 0) {
    searchStart.setDate(searchStart.getDate() + daysOffset);
    searchStart.setHours(0, 0, 0, 0);
    const dow = searchStart.getDay();
    const daysToMonday = dow === 0 ? -6 : 1 - dow;
    if (daysToMonday < 0) searchStart.setDate(searchStart.getDate() + daysToMonday);
    const minEnd = new Date(searchStart.getTime() + 7 * 24 * 60 * 60 * 1000);
    searchHours  = Math.max(searchHours, (minEnd - now) / (60 * 60 * 1000));
  }
  const searchEnd = new Date(now.getTime() + searchHours * 60 * 60 * 1000);

  const freebusyRes = await calendarClient.freebusy.query({
    requestBody: {
      timeMin: now.toISOString(),
      timeMax: searchEnd.toISOString(),
      items: [{ id: CALENDAR_ID }],
    },
  });

  const busyTimes = (freebusyRes.data.calendars[CALENDAR_ID]?.busy || []).map(b => ({
    start: new Date(b.start), end: new Date(b.end),
  }));

  const current = new Date(searchStart);
  if (daysOffset === 0 && category === 'emergency') {
    current.setTime(Math.max(current.getTime(), now.getTime() + 30 * 60 * 1000));
  }
  if (daysOffset === 0) snapToNext30(current);
  else {
    const h = BUSINESS_HOURS[current.getDay()];
    if (!h) advanceToNextBusinessOpen(current);
    else current.setHours(h.open, 0, 0, 0);
  }

  const slots = [];
  let safety  = 0;

  while (slots.length < maxOptions && current < searchEnd && safety++ < 500) {
    const dayHours = BUSINESS_HOURS[current.getDay()];
    if (!dayHours) { advanceToNextBusinessOpen(current); continue; }
    if (current.getHours() < dayHours.open) { current.setHours(dayHours.open, 0, 0, 0); continue; }

    const currentHour = current.getHours();
    if (timePreference === 'morning'   && currentHour >= 12) { advanceToNextBusinessOpen(current); continue; }
    if (timePreference === 'afternoon' && currentHour <  12) { current.setHours(12, 0, 0, 0); continue; }

    const slotEnd        = new Date(current.getTime() + durationMinutes * 60 * 1000);
    const slotEndMinutes = slotEnd.getHours() * 60 + slotEnd.getMinutes();
    if (slotEndMinutes > dayHours.close * 60) { advanceToNextBusinessOpen(current); continue; }

    const conflict = busyTimes.find(b => current < b.end && slotEnd > b.start);
    if (!conflict) {
      slots.push(new Date(current));
      if (category === 'emergency') { current.setTime(slotEnd.getTime()); snapToNext30(current); }
      else advanceToNextBusinessOpen(current);
    } else {
      current.setTime(conflict.end.getTime());
      snapToNext30(current);
    }
  }

  return { slots, durationMinutes, formatted: slots.map(formatSlotForSpeech) };
}

// ─────────────────────────────────────────────────────────────────────────────
// Create a Google Calendar appointment
// ─────────────────────────────────────────────────────────────────────────────
async function createAppointment({ name, phone, reason, category, patientType, datetime, durationMinutes }) {
  const startTime = new Date(datetime);
  const endTime   = new Date(startTime.getTime() + durationMinutes * 60 * 1000);

  const conflictCheck = await calendarClient.freebusy.query({
    requestBody: {
      timeMin: startTime.toISOString(),
      timeMax: endTime.toISOString(),
      items: [{ id: CALENDAR_ID }],
    },
  });

  if ((conflictCheck.data.calendars[CALENDAR_ID]?.busy || []).length > 0) throw new Error('SLOT_TAKEN');

  const labels = { emergency: '🚨 EMERGENCY', high_value: '⭐ HIGH VALUE', routine: '📋 ROUTINE' };
  const colors = { emergency: '11', high_value: '5', routine: '2' };

  const event = {
    summary: `${labels[category]} — ${name} (${reason})`,
    description: [
      `Patient: ${name}`, `Phone: ${phone}`, `Reason: ${reason}`,
      `Type: ${patientType} patient`, `Category: ${category}`, `Booked via AI Voice Agent`,
    ].join('\n'),
    start: { dateTime: startTime.toISOString(), timeZone: process.env.TZ || 'America/New_York' },
    end:   { dateTime: endTime.toISOString(),   timeZone: process.env.TZ || 'America/New_York' },
    colorId: colors[category],
  };

  const res = await calendarClient.events.insert({ calendarId: CALENDAR_ID, requestBody: event });
  return res.data;
}

// ─────────────────────────────────────────────────────────────────────────────
// Express routes
// ─────────────────────────────────────────────────────────────────────────────
app.get('/', (req, res) => res.send('Realtime Voice Agent V2 is running'));

app.post('/voice', (req, res) => {
  const twiml   = new twilio.twiml.VoiceResponse();
  const connect = twiml.connect();
  const stream  = connect.stream({ url: `wss://${req.headers.host}/ws` });
  if (req.body.From) stream.parameter({ name: 'callerNumber', value: req.body.From });
  twiml.hangup();
  res.type('text/xml');
  res.send(twiml.toString());
});

const server = app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

// ─────────────────────────────────────────────────────────────────────────────
// Build session instructions
// ─────────────────────────────────────────────────────────────────────────────
function buildSessionInstructions(callerPhone) {
  const displayPhone = callerPhone
    ? callerPhone
    : '[CALLER_NUMBER_PENDING — do NOT say this aloud, wait for it to be set]';

  return `
You are a warm, friendly dental receptionist at Bright Smile Dental — like a real person answering the phone, not a robot.
Speak English only. Never invent the caller's side of the conversation.

SOUND HUMAN:
- Use natural acknowledgments: "Of course!", "Sure thing!", "Absolutely!", "Perfect!", "Okay!"
- Use contractions always: "we'll", "I'll", "you're", "that's", "let's", "don't"
- React naturally to what they say before moving on
- Vary your phrasing — don't repeat the same sentence structure every time
- Keep responses short and natural, like a real phone call — no long speeches
- Light filler is fine: "Let me check that for you", "One moment", "Great"
- Never sound like you're reading from a script

VISIT CATEGORIES:
- emergency  (#1 priority): tooth pain, swelling, broken tooth, bleeding, infection, trauma, abscess
- high_value (#2 priority): implants, cosmetics, veneers, Invisalign, whitening, smile makeover
- routine    (#3 priority): checkup, cleaning, x-rays, general exam, fillings

════════════════════════════════════════════
EXACT FLOW — follow every step in order:
════════════════════════════════════════════

STEP 1 — Greet: "Hi, thanks for calling Bright Smile Dental, how can I help you today?"
         Wait for them to explain why they're calling.

STEP 2 — If EMERGENCY: ask EXACTLY ONE follow-up (choose the most relevant):
         "Are you in any pain right now?" or "Is there any swelling?" or "How long has this been going on?"
         Only ONE question. Then move on.

STEP 3 — Ask: "Can I get your full name?" (you need first AND last name — always ask for full name)

STEP 4 — Ask: "Are you a new or existing patient?"

STEP 5 — Ask: "Do you prefer morning or afternoon appointments?"
         Also listen for any time window preference they mention (e.g. "next week", "not until next week", "in two weeks").
         You do NOT need to ask a separate question for this — just note it if they say it.

STEP 6 — Call check_availability with the correct category, patient_type, reason, time_preference,
         and days_offset if they mentioned a future week:
         • "next week" or "not until next week" → days_offset: 7
         • "in two weeks" → days_offset: 14
         • No preference / "as soon as possible" → days_offset: 0 (default)

STEP 7 — Read the 2 available time options aloud. Ask which works better.
         STOP. Wait for the caller to pick a specific time.

STEP 8 — PHONE CONFIRMATION (do this BEFORE calling book_appointment):
         Say: "I have ${displayPhone} as the best number to reach you — is that correct?"
         STOP. Wait for yes or no.
         • If YES → go to Step 9 using ${displayPhone}.
         • If NO  → ask "What number would you prefer we use?" Wait for their answer.
                    Use the number they give you in Step 9.

STEP 9 — NOW call book_appointment with:
         name (full), phone (confirmed in Step 8), reason, category, patient_type,
         datetime (exact ISO string from the slots array), duration_minutes.

STEP 10 — After booking is confirmed, give the closing summary in ONE sentence:
          "[Full name], you're all set! We have you booked for [reason] on [day] at [time]. We'll see you then — thank you, and have a great day!"
          Do NOT repeat the phone number — it was already confirmed in Step 8.
          Then call the end_call tool. Do not say anything else.

════════════════════════════════════════════
CRITICAL RULES — never break these:
════════════════════════════════════════════
- NEVER ask for a phone number during Steps 1–7. No phone questions before Step 8.
- NEVER call book_appointment before completing Step 8 (phone confirmation).
- ONE question at a time — wait for the answer before asking the next.
- Always collect FULL name (first and last).
- At Step 8 ask yes/no FIRST. Only ask for a new number if they say no.
- Do not diagnose conditions. Do not offer medical advice.

TONE:
- emergency:  warm empathy, move efficiently
- high_value: warm, attentive, unhurried
- routine:    relaxed and friendly
  `;
}

// ─────────────────────────────────────────────────────────────────────────────
// WebSocket bridge: Twilio <-> OpenAI Realtime
// ─────────────────────────────────────────────────────────────────────────────
const wss = new WebSocket.Server({ server });

wss.on('connection', (twilioWs) => {
  console.log('Twilio connected');

  let streamSid                    = null;
  let callSid                      = null;
  let callerPhoneNumber            = null;
  let openaiReady                  = false;
  let greetingSent                 = false;
  let greetingComplete              = false;  // true only after greeting response.done fires
  let callClosed                   = false;
  let callBooked                   = false;
  let pendingHangup                = false;
  let waitingForTwilioPlaybackMark = false;
  const FINAL_PLAYBACK_MARK        = 'final-summary-played';
  let assistantSpeaking            = false;
  let callerHasStartedSpeaking     = false;
  let ignoreCallerAudioUntil       = 0;  // epoch ms — ignore VAD events until this time

  let callPhase             = 'collecting';
  let pendingCallerResponse = false;
  let offeredSlots          = [];
  let bookedAppointment     = null; // populated after successful book_appointment

  let currentFunctionName    = null;
  let currentFunctionCallId  = null;
  let functionCallArgsBuffer = '';

  const openaiWs = new WebSocket(
    'wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview',
    {
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        'OpenAI-Beta': 'realtime=v1',
      },
    }
  );

  function doHangup() {
    if (callClosed) return;
    console.log('doHangup called — callSid:', callSid);
    if (callSid) {
      twilioClient.calls(callSid).update({ status: 'completed' })
        .then(() => console.log('Call ended via REST API'))
        .catch(err => console.error('REST hangup failed:', err.message));
    }
    setTimeout(() => {
      if (!callClosed) { console.log('Closing WebSocket to end call'); twilioWs.close(); }
    }, 1500);
  }

  function sendTwilioMark(name) {
    if (!callClosed && twilioWs.readyState === WebSocket.OPEN && streamSid)
      twilioWs.send(JSON.stringify({ event: 'mark', streamSid, mark: { name } }));
  }

  function safeSendToOpenAI(payload) {
    if (!callClosed && openaiWs.readyState === WebSocket.OPEN) openaiWs.send(JSON.stringify(payload));
  }

  function safeSendToTwilio(payload) {
    if (!callClosed && twilioWs.readyState === WebSocket.OPEN) twilioWs.send(JSON.stringify(payload));
  }

  function createAssistantResponse(instructionsText) {
    if (callClosed) return;
    assistantSpeaking        = true;
    callerHasStartedSpeaking = false;
    pendingCallerResponse    = false;
    // Reset cooldown — caller audio is invalid while AI is speaking
    ignoreCallerAudioUntil   = Infinity;
    safeSendToOpenAI({
      type: 'response.create',
      response: {
        modalities: ['audio', 'text'],
        ...(instructionsText ? { instructions: instructionsText } : {}),
      },
    });
  }

  function sendGreeting() {
    if (!openaiReady || !streamSid || greetingSent || callClosed) return;
    greetingSent = true;
    greetingComplete = false;
    // Clear any audio that arrived before the greeting starts — prevents
    // connection noise or echo from being processed as caller speech.
    safeSendToOpenAI({ type: 'input_audio_buffer.clear' });
    // Block VAD for the entire greeting duration + 1200ms tail
    ignoreCallerAudioUntil = Infinity;
    createAssistantResponse(
      'Speak in English only. Say exactly: "Hi, thanks for calling Bright Smile Dental, how can I help you today?" Then stop and wait for the caller to answer.'
    );
  }

  openaiWs.on('open', () => {
    console.log('Connected to OpenAI Realtime');

    // Flush any stale audio buffer so a fresh call never inherits
    // audio or context from a previous session on this process.
    safeSendToOpenAI({ type: 'input_audio_buffer.clear' });


    safeSendToOpenAI({
      type: 'session.update',
      session: {
        modalities: ['audio', 'text'],
        instructions: buildSessionInstructions(null),
        voice: 'sage',
        temperature: 0.9,
        input_audio_format: 'g711_ulaw',
        output_audio_format: 'g711_ulaw',
        turn_detection: {
          type: 'server_vad',
          threshold: 0.85,
          prefix_padding_ms: 300,
          silence_duration_ms: 1200,
          create_response: false,
          interrupt_response: true,
        },
        tools: [
          {
            type: 'function',
            name: 'check_availability',
            description: 'Check available appointment slots. Call this after collecting: reason for visit, full name, new/existing status, and morning/afternoon preference. Do NOT wait for phone number — that is confirmed later.',
            parameters: {
              type: 'object',
              properties: {
                category:        { type: 'string', enum: ['emergency', 'high_value', 'routine'], description: 'emergency = urgent pain/trauma. high_value = cosmetic/implants. routine = checkup/cleaning.' },
                patient_type:    { type: 'string', enum: ['new', 'existing'] },
                reason:          { type: 'string', description: 'Brief description of why they are calling.' },
                time_preference: { type: 'string', enum: ['morning', 'afternoon', 'any'], description: 'morning = 7am-12pm, afternoon = 12pm-4pm, any = no preference.' },
                days_offset:     { type: 'number', description: 'Days from today to start searching. 0 = soonest. 7 = next week. 14 = in two weeks.' },
              },
              required: ['category', 'patient_type', 'reason', 'time_preference'],
            },
          },
          {
            type: 'function',
            name: 'book_appointment',
            description: 'Book the appointment on the calendar once the caller has agreed on a specific time slot.',
            parameters: {
              type: 'object',
              properties: {
                name:             { type: 'string', description: "Caller's full name." },
                phone:            { type: 'string', description: "Caller's callback phone number." },
                reason:           { type: 'string', description: 'Reason for the visit.' },
                category:         { type: 'string', enum: ['emergency', 'high_value', 'routine'] },
                patient_type:     { type: 'string', enum: ['new', 'existing'] },
                datetime:         { type: 'string', description: 'ISO 8601 datetime of the appointment start.' },
                duration_minutes: { type: 'number', description: 'Appointment duration in minutes.' },
              },
              required: ['name', 'phone', 'reason', 'category', 'patient_type', 'datetime', 'duration_minutes'],
            },
          },
          {
            type: 'function',
            name: 'end_call',
            description: 'End the call. Call this immediately after finishing the closing summary. No parameters needed.',
            parameters: { type: 'object', properties: {}, required: [] },
          },
        ],
        tool_choice: 'auto',
      },
    });

    openaiReady = true;
    sendGreeting();
  });

  openaiWs.on('message', async (message) => {
    try {
      const data = JSON.parse(message.toString());

      if (data.type !== 'response.audio.delta') console.log('OpenAI event:', data.type);

      if (data.type === 'response.audio.delta' && data.delta && streamSid)
        safeSendToTwilio({ event: 'media', streamSid, media: { payload: data.delta } });

      if (data.type === 'response.output_item.added' && data.item?.type === 'function_call') {
        currentFunctionName    = data.item.name;
        currentFunctionCallId  = data.item.call_id;
        functionCallArgsBuffer = '';
        console.log(`Tool call started: ${currentFunctionName}`);
      }

      if (data.type === 'response.function_call_arguments.delta')
        functionCallArgsBuffer += data.delta;

      if (data.type === 'response.function_call_arguments.done') {
        const args   = JSON.parse(functionCallArgsBuffer);
        const fnName = currentFunctionName;
        const callId = currentFunctionCallId;
        console.log(`Executing tool: ${fnName}`, args);

        let result;
        try {

          // ── end_call ──────────────────────────────────────────────────────
          if (fnName === 'end_call') {
            console.log('end_call received — firing SMS + sheet log, then hanging up');
            pendingHangup = true;
            result = { success: true };

            safeSendToOpenAI({
              type: 'conversation.item.create',
              item: { type: 'function_call_output', call_id: callId, output: JSON.stringify(result) },
            });

            // Fire all three post-call actions in parallel — all non-fatal
            if (bookedAppointment) {
              console.log('Firing post-call actions for:', JSON.stringify(bookedAppointment));
              Promise.all([
                sendOwnerSummaryText(bookedAppointment),
                sendCustomerConfirmationText(bookedAppointment),
                logToSheet(bookedAppointment),
              ]).then(() => console.log('All post-call actions completed'))
                .catch(err => console.error('Post-call action error:', err.message));
            } else {
              console.warn('end_call fired but bookedAppointment is null — no SMS or sheet log sent');
            }

            return; // hang up after response.done + Twilio mark

          // ── check_availability ────────────────────────────────────────────
          } else if (fnName === 'check_availability') {
            const availability = await getAvailableSlots(
              args.category, args.patient_type, args.reason,
              args.time_preference || 'any', args.days_offset || 0
            );

            offeredSlots = availability.slots.map(s => ({
              iso: s.toISOString(), durationMinutes: availability.durationMinutes,
            }));

            result = {
              success: true, category: args.category,
              duration_minutes: availability.durationMinutes,
              slots:           availability.slots.map(s => s.toISOString()),
              formatted_slots: availability.formatted,
            };

          // ── book_appointment ──────────────────────────────────────────────
          } else if (fnName === 'book_appointment') {
            const requestedMs = new Date(args.datetime).getTime();
            const closestSlot = offeredSlots.reduce((best, s) => {
              const diff = Math.abs(new Date(s.iso).getTime() - requestedMs);
              return (!best || diff < best.diff) ? { slot: s, diff } : best;
            }, null);

            const datetimeToBook = closestSlot ? closestSlot.slot.iso             : args.datetime;
            const durationToBook = closestSlot ? closestSlot.slot.durationMinutes : args.duration_minutes;

            const phoneToUse = (args.phone && args.phone !== 'TO_BE_CONFIRMED' && args.phone !== 'unknown')
              ? args.phone : (callerPhoneNumber || 'unknown');

            offeredSlots = [];
            callBooked   = true;

            const event = await createAppointment({
              name: args.name, phone: phoneToUse, reason: args.reason,
              category: args.category, patientType: args.patient_type,
              datetime: datetimeToBook, durationMinutes: durationToBook,
            });

            // Store for post-call SMS + sheet log
            bookedAppointment = {
              name: args.name, phone: phoneToUse, reason: args.reason,
              category: args.category, patientType: args.patient_type,
              datetime: datetimeToBook, durationMinutes: durationToBook,
            };

            result = { success: true, event_id: event.id, message: 'Appointment booked successfully.' };
          }

        } catch (err) {
          console.error(`Tool ${fnName} failed:`, err.message);
          if (fnName === 'book_appointment') { callBooked = false; bookedAppointment = null; }

          result = err.message === 'SLOT_TAKEN'
            ? { success: false, error: 'SLOT_TAKEN', message: 'That slot was just taken. Call check_availability again to get fresh times.' }
            : { success: false, error: err.message };
        }

        console.log(`${fnName} result:`, result);

        safeSendToOpenAI({
          type: 'conversation.item.create',
          item: { type: 'function_call_output', call_id: callId, output: JSON.stringify(result) },
        });

        if (fnName === 'check_availability') {
          callPhase = result.success ? 'slots_offered' : callPhase;
          createAssistantResponse(result.success
            ? 'The calendar has been checked. Read ONLY the 2 time options from formatted_slots to the caller. Say something like "I have [slot 1] or [slot 2] — which works better for you?" Then STOP. Do not mention the phone number. Do not call book_appointment. Just offer the 2 slots and wait for the caller to choose.'
            : "The calendar check failed. Apologize briefly and tell the caller you're having trouble accessing the schedule, then ask them to call back or leave a number for a callback."
          );

        } else if (fnName === 'book_appointment') {
          if (result.success) {
            createAssistantResponse(
              "The appointment is confirmed. Give the closing summary — keep it to ONE short sentence: '[Full name], you're all set! We have you booked for [reason] on [day] at [time]. We'll see you then — thank you, and have a great day!' Do NOT mention the phone number again — it was already confirmed. Then immediately call the end_call tool. Do not say anything else."
            );
          } else if (result.error === 'SLOT_TAKEN') {
            createAssistantResponse(
              'That slot was just taken by another caller. Say: "Sorry about that — that time just got taken. Let me find you some fresh options." Then call check_availability again with the same details and offer the new 2 slots.'
            );
          } else {
            createAssistantResponse('The booking failed. Apologize and call check_availability again to offer fresh time options to the caller.');
          }
        }
      }

      if (data.type === 'response.done') {
        assistantSpeaking = false;
        // 1200ms cooldown after AI stops — clears echo/audio tail from the line
        // before we start listening for real caller speech.
        ignoreCallerAudioUntil = Date.now() + 1200;
        console.log('Assistant finished speaking — cooldown started');

        // Mark greeting as complete so speech_stopped can now trigger responses
        if (!greetingComplete) {
          greetingComplete = true;
          console.log('Greeting complete — now listening for caller');
        }

        if (pendingHangup) {
          pendingHangup                = false;
          waitingForTwilioPlaybackMark = true;
          console.log('OpenAI done — sending Twilio mark, waiting for playback to finish');
          sendTwilioMark(FINAL_PLAYBACK_MARK);
          // Reset speech tracking so stale state doesn't bleed into next turn
          callerHasStartedSpeaking = false;
          return;
        }

        // Only react to an interruption if the caller ACTUALLY spoke during
        // this AI turn. Prevents response.done from auto-firing after the
        // greeting (or any other AI turn) before the caller has said anything.
        if (pendingCallerResponse && callerHasStartedSpeaking) {
          pendingCallerResponse    = false;
          callerHasStartedSpeaking = false;
          createAssistantResponse(
            'The caller spoke while you were talking. Listen to what they said and respond naturally. Continue with whatever you were in the middle of asking them — do not skip ahead. One question at a time.'
          );
        } else {
          // AI finished speaking, caller hasn't spoken yet — just wait.
          pendingCallerResponse    = false;
          callerHasStartedSpeaking = false;
        }
      }

      if (data.type === 'input_audio_buffer.speech_started') {
        if (Date.now() < ignoreCallerAudioUntil) {
          console.log('speech_started ignored — within AI audio cooldown');
        } else {
          callerHasStartedSpeaking = true;
          console.log('Caller started speaking');
        }
      }

      if (data.type === 'input_audio_buffer.speech_stopped') {
        if (Date.now() < ignoreCallerAudioUntil) {
          console.log('speech_stopped ignored — within AI audio cooldown');
          // Also clear the buffer so no stale audio gets processed
          safeSendToOpenAI({ type: 'input_audio_buffer.clear' });
          return;
        }
        console.log('Caller stopped speaking');

        // Do not respond until greeting has fully finished playing
        if (!greetingComplete) {
          console.log('speech_stopped ignored — greeting not yet complete');
          safeSendToOpenAI({ type: 'input_audio_buffer.clear' });
          return;
        }

        if (callerHasStartedSpeaking && !callBooked) {
          if (!assistantSpeaking) {
            let instruction;

            if (callPhase === 'slots_offered') {
              callPhase = 'confirming_phone';
              const phoneDisplay = callerPhoneNumber || 'the number you called from';
              instruction = `The caller just picked a time slot. Do NOT call book_appointment yet. Ask ONLY this one question: "I have ${phoneDisplay} as the best number to reach you — is that correct?" Then STOP and wait for their answer. Do not book. Do not say anything else.`;

            } else if (callPhase === 'confirming_phone') {
              callPhase = 'done';
              const phoneDisplay = callerPhoneNumber || 'unknown';
              instruction = `The caller just responded to the phone confirmation. If they said yes, call book_appointment using phone="${phoneDisplay}". If they said no or gave a different number, use that new number instead. Call book_appointment now with the correct phone, full name, reason, category, patient_type, datetime (exact ISO string from the slots array), and duration_minutes.`;

            } else {
              instruction = "Respond in English as the dental receptionist. Continue from the caller's last message. Follow the session flow: understand issue → full name (first and last) → new/existing → morning or afternoon preference → call check_availability. NEVER ask for a phone number. One question at a time.";
            }

            createAssistantResponse(instruction);
          } else {
            pendingCallerResponse = true;
            console.log('Caller interrupted — will respond after AI finishes');
          }
        }
      }

      if (data.type === 'error') console.error('OpenAI error:', JSON.stringify(data, null, 2));

    } catch (error) {
      console.error('Error processing OpenAI message:', error.message);
    }
  });

  twilioWs.on('message', (message) => {
    try {
      const data = JSON.parse(message.toString());
      if (data.event !== 'media') console.log('Twilio event:', data.event);

      if (data.event === 'start') {
        streamSid         = data.start.streamSid;
        callSid           = data.start.callSid || null;
        callerPhoneNumber = data.start.customParameters?.callerNumber || null;
        console.log('Caller number:', callerPhoneNumber || 'unknown');
        console.log('Call SID:', callSid || 'unknown');

        // Update instructions with the real caller number now that we have it.
        // We send ONLY instructions here — no other session fields — so OpenAI
        // does not interpret this update as a cue to generate a new response.
        // Also clear the input buffer one more time in case any audio arrived
        // during the OpenAI handshake before Twilio sent the start event.
        if (callerPhoneNumber && openaiReady) {
          safeSendToOpenAI({ type: 'input_audio_buffer.clear' });
          safeSendToOpenAI({
            type: 'session.update',
            session: { instructions: buildSessionInstructions(callerPhoneNumber) },
          });
        }

        sendGreeting();
      }

      if (data.event === 'media')
        safeSendToOpenAI({ type: 'input_audio_buffer.append', audio: data.media.payload });

      if (data.event === 'mark') {
        const markName = data.mark?.name;
        console.log('Twilio mark received:', markName);
        if (waitingForTwilioPlaybackMark && markName === FINAL_PLAYBACK_MARK) {
          waitingForTwilioPlaybackMark = false;
          console.log('Twilio finished playing final audio — hanging up');
          setTimeout(() => doHangup(), 300);
        }
      }

      if (data.event === 'stop') console.log('Twilio stream stopped');

    } catch (error) {
      console.error('Error processing Twilio message:', error.message);
    }
  });

  twilioWs.on('close', () => {
    callClosed = true;
    console.log('Call ended');
    if (openaiWs.readyState === WebSocket.OPEN || openaiWs.readyState === WebSocket.CONNECTING)
      openaiWs.close();
  });

  openaiWs.on('close', () => console.log('OpenAI connection closed'));
  openaiWs.on('error', (err) => console.error('OpenAI WebSocket error:', err.message));
  twilioWs.on('error', (err) => console.error('Twilio WebSocket error:', err.message));
});

// ─────────────────────────────────────────────────────────────────────────────
// SETUP GUIDE
// ─────────────────────────────────────────────────────────────────────────────
//
// ══════════════════════════════════════════════════════
// PART 1 — GOOGLE CLOUD (one-time, covers both services)
// ══════════════════════════════════════════════════════
//
// 1. Go to https://console.cloud.google.com
//    Create a new project (e.g. "Dental Voice Agent")
//
// 2. Enable APIs:
//    → APIs & Services → Library
//    → Enable "Google Calendar API"
//    → Enable "Google Sheets API"
//
// 3. Create a Service Account:
//    → APIs & Services → Credentials → Create Credentials → Service Account
//    → Name it anything (e.g. "voice-agent") → Done
//    → Click the service account → Keys tab → Add Key → JSON
//    → Open the downloaded file and copy:
//        "client_email"  →  GOOGLE_SERVICE_ACCOUNT_EMAIL
//        "private_key"   →  GOOGLE_PRIVATE_KEY
//
// ══════════════════════════════════════════════════════
// PART 2 — GOOGLE CALENDAR
// ══════════════════════════════════════════════════════
//
// 4. Go to https://calendar.google.com
//    → + Other calendars → Create new calendar
//    → Name: "Bright Smile Dental Demo"
//    → Settings → Share with specific people
//    → Add your service account email → Permission: "Make changes to events"
//    → Settings → Integrate calendar → copy the Calendar ID
//    → This is your GOOGLE_CALENDAR_ID
//
// ══════════════════════════════════════════════════════
// PART 3 — GOOGLE SHEETS LEAD LOG
// ══════════════════════════════════════════════════════
//
// 5. Go to https://sheets.google.com → Blank spreadsheet
//    Name it: "Bright Smile Dental — Leads"
//
// 6. Add this header row in Row 1 (cells A1 through G1):
//    Timestamp | Patient Name | Phone | Reason | Category | Patient Type | Appointment
//
// 7. Share the sheet with your service account:
//    → Click Share → add your GOOGLE_SERVICE_ACCOUNT_EMAIL → Role: Editor
//
// 8. Get the Sheet ID from the URL:
//    https://docs.google.com/spreadsheets/d/YOUR_SHEET_ID_HERE/edit
//    → Copy the ID between /d/ and /edit
//    → This is your GOOGLE_SHEET_ID
//
// ══════════════════════════════════════════════════════
// PART 4 — RAILWAY ENVIRONMENT VARIABLES
// ══════════════════════════════════════════════════════
//
// Add all of these in Railway → Variables:
//
//   TWILIO_ACCOUNT_SID            = (from Twilio console)
//   TWILIO_AUTH_TOKEN             = (from Twilio console)
//   TWILIO_PHONE_NUMBER           = +1XXXXXXXXXX   ← your Twilio number
//   OWNER_PHONE                   = +1XXXXXXXXXX   ← your personal cell
//   OPENAI_API_KEY                = (from OpenAI)
//   GOOGLE_SERVICE_ACCOUNT_EMAIL  = (client_email from JSON)
//   GOOGLE_PRIVATE_KEY            = (private_key from JSON — keep the \n characters)
//   GOOGLE_CALENDAR_ID            = (from Part 2)
//   GOOGLE_SHEET_ID               = (from Part 3, step 8)
//   TZ                            = America/New_York
//
// DEMO MODE:
//   Set OWNER_PHONE to your personal number. Both the owner summary SMS and
//   the customer confirmation SMS will land on your phone so you can show
//   both during a live demo.
//
//   When going to production:
//   - Change OWNER_PHONE to the real practice owner's number
//   - In sendCustomerConfirmationText(), swap `to: OWNER_PHONE` → `to: phone`
//
// ══════════════════════════════════════════════════════
// PART 5 — DEPLOY
// ══════════════════════════════════════════════════════
//
//   npm install googleapis   (if not already installed)
//   git add server.js
//   git commit -m "add Sheets logging + demo SMS routing"
//   git push
//
// ─────────────────────────────────────────────────────────────────────────────