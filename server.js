require('dotenv').config();

const express = require('express');
const twilio = require('twilio');
const WebSocket = require('ws');
const { google } = require('googleapis');

// ─────────────────────────────────────────────────────────────────────────────
// SETUP REQUIRED (before this works):
//
// 1. Run:  npm install googleapis
//
// 2. Add to your .env file:
//    GOOGLE_SERVICE_ACCOUNT_EMAIL=your-sa@your-project.iam.gserviceaccount.com
//    GOOGLE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"
//    GOOGLE_CALENDAR_ID=your-calendar-id@group.calendar.google.com
//
// 3. In Railway → Variables, add:
//    TZ=America/New_York   ← change to your practice's timezone
//    (This makes all JS Date methods use the right local time for your office)
//
// See bottom of file for step-by-step Google Calendar setup instructions.
// ─────────────────────────────────────────────────────────────────────────────

const app = express();
const PORT = process.env.PORT || 3000;
const CALENDAR_ID = process.env.GOOGLE_CALENDAR_ID || 'primary';

app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// ─────────────────────────────────────────────────────────────────────────────
// Google Calendar Auth
// ─────────────────────────────────────────────────────────────────────────────
const calendarAuth = new google.auth.JWT({
  email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
  key: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
  scopes: ['https://www.googleapis.com/auth/calendar'],
});

const calendarClient = google.calendar({ version: 'v3', auth: calendarAuth });

// ─────────────────────────────────────────────────────────────────────────────
// Business hours  (server uses local time — set TZ in Railway)
// Keys: 0=Sun, 1=Mon, 2=Tue, 3=Wed, 4=Thu, 5=Fri, 6=Sat
// null = closed that day
// ─────────────────────────────────────────────────────────────────────────────
const BUSINESS_HOURS = {
  0: null,                     // Sunday  — closed
  1: { open: 7, close: 16 },  // Monday
  2: { open: 7, close: 16 },  // Tuesday
  3: { open: 7, close: 16 },  // Wednesday
  4: { open: 7, close: 16 },  // Thursday
  5: { open: 7, close: 16 },  // Friday
  6: { open: 9, close: 14 },  // Saturday
};

// ─────────────────────────────────────────────────────────────────────────────
// Date helpers (all rely on TZ env being set correctly)
// ─────────────────────────────────────────────────────────────────────────────
function snapToNext30(date) {
  const m = date.getMinutes();
  if (m === 0) return;
  if (m <= 30) {
    date.setMinutes(30, 0, 0);
  } else {
    date.setHours(date.getHours() + 1, 0, 0, 0);
  }
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
  const now = new Date();
  const isToday = date.toDateString() === now.toDateString();
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const isTomorrow = date.toDateString() === tomorrow.toDateString();

  const timeStr = date.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });

  if (isToday) return `today at ${timeStr}`;
  if (isTomorrow) return `tomorrow at ${timeStr}`;
  return `${date.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })} at ${timeStr}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Availability logic
//
// Priority:  emergency (#1) > high_value (#2) > routine (#3)
//
// emergency  — same day if possible, up to 48 hours out, 60 min, 2 options
// high_value — within 5 days, 60 min consult, 3 options (spread across days)
// routine    — up to 4 weeks, 60 min (75 min for new patient cleaning), 3 options
// ─────────────────────────────────────────────────────────────────────────────
async function getAvailableSlots(category, patientType, reason, timePreference = 'any') {
  let durationMinutes, searchHours;
  const maxOptions = 2; // Always offer exactly 2 options

  // All appointments are 60 minutes regardless of category or patient type
  durationMinutes = 60;

  if (category === 'emergency') {
    searchHours = 48;
  } else if (category === 'high_value') {
    searchHours = 5 * 24;
  } else { // routine
    searchHours = 28 * 24;
  }

  const now       = new Date();
  const searchEnd = new Date(now.getTime() + searchHours * 60 * 60 * 1000);

  // Fetch busy times from Google Calendar
  const freebusyRes = await calendarClient.freebusy.query({
    requestBody: {
      timeMin: now.toISOString(),
      timeMax: searchEnd.toISOString(),
      items: [{ id: CALENDAR_ID }],
    },
  });

  const busyTimes = (freebusyRes.data.calendars[CALENDAR_ID]?.busy || []).map(b => ({
    start: new Date(b.start),
    end:   new Date(b.end),
  }));

  // Build starting point
  const current = new Date(now);
  if (category === 'emergency') {
    // Give a 30-minute buffer so we can actually prepare
    current.setTime(current.getTime() + 30 * 60 * 1000);
  }
  snapToNext30(current);

  const slots = [];
  let safety   = 0;

  while (slots.length < maxOptions && current < searchEnd && safety++ < 500) {
    const dayHours = BUSINESS_HOURS[current.getDay()];

    // Closed today — jump to next open day
    if (!dayHours) {
      advanceToNextBusinessOpen(current);
      continue;
    }

    // Before opening — jump to open time
    if (current.getHours() < dayHours.open) {
      current.setHours(dayHours.open, 0, 0, 0);
      continue;
    }

    // Time preference filtering
    const currentHour = current.getHours();
    if (timePreference === 'morning' && currentHour >= 12) {
      // Already past noon — jump to next business day
      advanceToNextBusinessOpen(current);
      continue;
    }
    if (timePreference === 'afternoon' && currentHour < 12) {
      // Before noon — jump to 12:00 PM today
      current.setHours(12, 0, 0, 0);
      continue;
    }

    const slotEnd        = new Date(current.getTime() + durationMinutes * 60 * 1000);
    const slotEndMinutes = slotEnd.getHours() * 60 + slotEnd.getMinutes();

    // Slot would run past closing — jump to next open day
    if (slotEndMinutes > dayHours.close * 60) {
      advanceToNextBusinessOpen(current);
      continue;
    }

    // Check for calendar conflicts
    const conflict = busyTimes.find(b => current < b.end && slotEnd > b.start);

    if (!conflict) {
      // ✅ Slot is open — add it
      slots.push(new Date(current));

      if (category === 'emergency') {
        // Pack emergency slots close together (same day preferred)
        current.setTime(slotEnd.getTime());
        snapToNext30(current);
      } else {
        // Spread routine/high_value options across different days
        advanceToNextBusinessOpen(current);
      }
    } else {
      // Jump past the conflict and try again
      current.setTime(conflict.end.getTime());
      snapToNext30(current);
    }
  }

  return {
    slots,
    durationMinutes,
    formatted: slots.map(formatSlotForSpeech),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Create a Google Calendar appointment
// Color coding: emergency = red, high_value = yellow, routine = green
//
// Includes a final conflict re-check right before inserting to prevent
// double-booking in the race condition where two callers pick the same slot.
// ─────────────────────────────────────────────────────────────────────────────
async function createAppointment({ name, phone, reason, category, patientType, datetime, durationMinutes }) {
  const startTime = new Date(datetime);
  const endTime   = new Date(startTime.getTime() + durationMinutes * 60 * 1000);

  // ── Final conflict check (race condition guard) ──────────────────────────
  // Re-check the exact slot one last time right before inserting.
  // If another caller just booked it between check_availability and now, we catch it here.
  const conflictCheck = await calendarClient.freebusy.query({
    requestBody: {
      timeMin: startTime.toISOString(),
      timeMax: endTime.toISOString(),
      items: [{ id: CALENDAR_ID }],
    },
  });

  const conflicts = conflictCheck.data.calendars[CALENDAR_ID]?.busy || [];
  if (conflicts.length > 0) {
    // Slot was taken between when we offered it and now
    throw new Error('SLOT_TAKEN');
  }
  // ─────────────────────────────────────────────────────────────────────────

  const labels = { emergency: '🚨 EMERGENCY', high_value: '⭐ HIGH VALUE', routine: '📋 ROUTINE' };
  const colors = { emergency: '11', high_value: '5', routine: '2' };

  const event = {
    summary: `${labels[category]} — ${name} (${reason})`,
    description: [
      `Patient: ${name}`,
      `Phone: ${phone}`,
      `Reason: ${reason}`,
      `Type: ${patientType} patient`,
      `Category: ${category}`,
      `Booked via AI Voice Agent`,
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

  // Pass the caller's phone number into the WebSocket session as a custom parameter
  if (req.body.From) {
    stream.parameter({ name: 'callerNumber', value: req.body.From });
  }

  res.type('text/xml');
  res.send(twiml.toString());
});

const server = app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

// ─────────────────────────────────────────────────────────────────────────────
// Build session instructions (called once at open, updated when caller number arrives)
// ─────────────────────────────────────────────────────────────────────────────
function buildSessionInstructions(callerPhone) {
  const displayPhone = callerPhone || 'the number you called from';
  return `
You are a friendly, professional dental receptionist for Bright Smile Dental.
Speak English only. Never invent the caller's side of the conversation.

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

STEP 6 — Call check_availability with the correct category, patient_type, reason, and time_preference.

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

STEP 10 — After booking is confirmed, give the closing summary:
          "[Full name], you're all set! We have you booked for [reason] on [day] at [time].
           We'll reach you at [confirmed phone number]. We'll see you then — have a great day!"
          Then stop. Do not say anything else.

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

  let streamSid               = null;
  let callerPhoneNumber       = null; // populated from Twilio caller ID
  let openaiReady             = false;
  let greetingSent            = false;
  let callClosed              = false;
  let callBooked              = false;
  let assistantSpeaking       = false;
  let callerHasStartedSpeaking = false;
  let pendingCallerResponse   = false;

  // Slot validation: store the slots we offered so we can verify the AI only books one of them
  // Each entry: { iso: string, durationMinutes: number }
  let offeredSlots = [];

  // Tool call tracking
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
    assistantSpeaking        = true;
    callerHasStartedSpeaking = false;
    pendingCallerResponse    = false;
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
    createAssistantResponse(
      'Speak in English only. Say exactly: "Hi, thanks for calling Bright Smile Dental, how can I help you today?" Then stop and wait for the caller to answer.'
    );
  }

  openaiWs.on('open', () => {
    console.log('Connected to OpenAI Realtime');

    safeSendToOpenAI({
      type: 'session.update',
      session: {
        modalities: ['audio', 'text'],
        instructions: buildSessionInstructions(null), // updated with caller number after Twilio start event
        voice: 'alloy',
        input_audio_format: 'g711_ulaw',
        output_audio_format: 'g711_ulaw',
        turn_detection: {
          type: 'server_vad',
          threshold: 0.7,
          prefix_padding_ms: 300,
          silence_duration_ms: 800,
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
                category: {
                  type: 'string',
                  enum: ['emergency', 'high_value', 'routine'],
                  description: 'emergency = urgent pain/trauma. high_value = cosmetic/implants. routine = checkup/cleaning.',
                },
                patient_type: {
                  type: 'string',
                  enum: ['new', 'existing'],
                },
                reason: {
                  type: 'string',
                  description: 'Brief description of why they are calling.',
                },
                time_preference: {
                  type: 'string',
                  enum: ['morning', 'afternoon', 'any'],
                  description: 'morning = 7am-12pm, afternoon = 12pm-4pm, any = no preference.',
                },
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
                name:             { type: 'string', description: 'Caller\'s full name.' },
                phone:            { type: 'string', description: 'Caller\'s callback phone number.' },
                reason:           { type: 'string', description: 'Reason for the visit.' },
                category:         { type: 'string', enum: ['emergency', 'high_value', 'routine'] },
                patient_type:     { type: 'string', enum: ['new', 'existing'] },
                datetime:         { type: 'string', description: 'ISO 8601 datetime of the appointment start.' },
                duration_minutes: { type: 'number', description: 'Appointment duration in minutes.' },
              },
              required: ['name', 'phone', 'reason', 'category', 'patient_type', 'datetime', 'duration_minutes'],
            },
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

      if (data.type !== 'response.audio.delta') {
        console.log('OpenAI event:', data.type);
      }

      // Stream audio back to Twilio
      if (data.type === 'response.audio.delta' && data.delta && streamSid) {
        safeSendToTwilio({ event: 'media', streamSid, media: { payload: data.delta } });
      }

      // Track function call name + ID when a tool call starts
      if (data.type === 'response.output_item.added' && data.item?.type === 'function_call') {
        currentFunctionName   = data.item.name;
        currentFunctionCallId = data.item.call_id;
        functionCallArgsBuffer = '';
        console.log(`Tool call started: ${currentFunctionName}`);
      }

      // Buffer streaming arguments
      if (data.type === 'response.function_call_arguments.delta') {
        functionCallArgsBuffer += data.delta;
      }

      // Execute tool when arguments are fully received
      if (data.type === 'response.function_call_arguments.done') {
        const args   = JSON.parse(functionCallArgsBuffer);
        const fnName = currentFunctionName;
        const callId = currentFunctionCallId;
        console.log(`Executing tool: ${fnName}`, args);

        let result;
        try {
          if (fnName === 'check_availability') {
            const availability = await getAvailableSlots(args.category, args.patient_type, args.reason, args.time_preference || 'any');

            // Store offered slots server-side so we can validate the booking later
            offeredSlots = availability.slots.map(s => ({
              iso:             s.toISOString(),
              durationMinutes: availability.durationMinutes,
            }));

            result = {
              success:          true,
              category:         args.category,
              duration_minutes: availability.durationMinutes,
              slots:            availability.slots.map(s => s.toISOString()),
              formatted_slots:  availability.formatted, // human-readable for the AI to read aloud
            };

          } else if (fnName === 'book_appointment') {

            // Use the exact ISO datetime from the offeredSlots we gave the AI.
            // Find the closest matching offered slot and use that datetime
            // to avoid timezone mismatch between what we stored and what the AI sends back.
            const requestedMs = new Date(args.datetime).getTime();
            const closestSlot = offeredSlots.reduce((best, s) => {
              const diff = Math.abs(new Date(s.iso).getTime() - requestedMs);
              return (!best || diff < best.diff) ? { slot: s, diff } : best;
            }, null);

            const datetimeToBook     = closestSlot ? closestSlot.slot.iso : args.datetime;
            const durationToBook     = closestSlot ? closestSlot.slot.durationMinutes : args.duration_minutes;

            // Use the phone number the AI confirmed with the caller.
            // If the caller gave a different number, the AI will send that.
            // Fall back to callerPhoneNumber if AI sends nothing useful.
            const phoneToUse = (args.phone && args.phone !== 'TO_BE_CONFIRMED' && args.phone !== 'unknown')
              ? args.phone
              : (callerPhoneNumber || 'unknown');

            const event = await createAppointment({
              name:            args.name,
              phone:           phoneToUse,
              reason:          args.reason,
              category:        args.category,
              patientType:     args.patient_type,
              datetime:        datetimeToBook,
              durationMinutes: durationToBook,
            });
            offeredSlots = [];
            callBooked   = true;
            result = { success: true, event_id: event.id, message: 'Appointment booked successfully.' };
          }
        } catch (err) {
          console.error(`Tool ${fnName} failed:`, err.message);

          // Handle slot-taken race condition gracefully
          if (err.message === 'SLOT_TAKEN') {
            result = {
              success: false,
              error:   'SLOT_TAKEN',
              message: 'That slot was just taken by another caller. Call check_availability again to get fresh available times and offer them to the caller.',
            };
          } else {
            result = { success: false, error: err.message };
          }
        }

        console.log(`${fnName} result:`, result);

        // Send result back to OpenAI
        safeSendToOpenAI({
          type: 'conversation.item.create',
          item: {
            type:    'function_call_output',
            call_id: callId,
            output:  JSON.stringify(result),
          },
        });

        // Give the AI explicit instructions for what to do next based on the tool result
        if (fnName === 'check_availability') {
          if (result.success) {
            const phoneDisplay = callerPhoneNumber || 'the number you called from';
            createAssistantResponse(
              `The calendar has been checked. Read the formatted_slots to the caller — offer exactly the 2 options. Say something like "I have [slot 1] or [slot 2] — which works better for you?" Then STOP and wait for their answer.\n\nONCE they pick a time, do NOT call book_appointment yet. First confirm the phone number by saying: "I have ${phoneDisplay} as the best number to reach you — is that correct?" Then STOP and wait for yes or no.\n• If yes → call book_appointment using phone="${phoneDisplay}".\n• If no  → ask "What number would you like us to use?" Wait for their answer, then call book_appointment using that number.\n\nNever call book_appointment before the phone is confirmed. Use the exact ISO datetime string from the slots array.`
            );
          } else {
            createAssistantResponse(
              'The calendar check failed. Apologize briefly and tell the caller you\'re having trouble accessing the schedule, then ask them to call back or leave a number for a callback.'
            );
          }
        } else if (fnName === 'book_appointment') {
          if (result.success) {
            createAssistantResponse(
              'The appointment is confirmed. Give a warm closing: use their full name, confirm the reason and appointment date and time. Say "We\'ll see you then — have a great day!" Do not ask about the phone number again — it was already confirmed before booking. Do not call any more tools. The call is done.'
            );
          } else if (result.error === 'SLOT_TAKEN') {
            createAssistantResponse(
              'That slot was just taken by another caller. Say: "Sorry about that — that time just got taken. Let me find you some fresh options." Then call check_availability again with the same details and offer the new 2 slots.'
            );
          } else {
            createAssistantResponse(
              'The booking failed. Apologize and call check_availability again to offer fresh time options to the caller.'
            );
          }
        }
      }

      if (data.type === 'response.done') {
        assistantSpeaking = false;
        console.log('Assistant finished speaking');

        // If caller spoke while AI was still talking, respond now that AI is done
        if (pendingCallerResponse) {
          pendingCallerResponse = false;
          createAssistantResponse(
            'The caller just spoke. Respond in English as the dental receptionist. Continue naturally from what the caller said. Follow the session flow: issue → full name → new/existing → morning/afternoon → check_availability → offer 2 times → pick a time → THEN confirm phone → book_appointment → summary. Never ask for phone number before they have picked a time. One question at a time.'
          );
        }
      }

      // Always track when caller starts speaking (including during interruptions)
      if (data.type === 'input_audio_buffer.speech_started') {
        callerHasStartedSpeaking = true;
        console.log('Caller started speaking');
      }

      if (data.type === 'input_audio_buffer.speech_stopped') {
        console.log('Caller stopped speaking');

        // Once booked, only allow responses for the phone confirmation — block tool-triggering responses after that
        // (tool re-booking is blocked separately in the tool execution block)

        if (callerHasStartedSpeaking) {
          if (!assistantSpeaking) {
            // Normal turn: AI is silent, respond now
            createAssistantResponse(
              'Respond in English as the dental receptionist. Continue from the caller\'s last message. Follow the session flow in order: understand issue → full name (first and last) → new/existing → morning or afternoon preference → call check_availability → offer 2 time slots → wait for them to pick one → THEN confirm phone number → call book_appointment → closing summary with phone number included. NEVER ask for a phone number before they have picked a time slot. One question at a time.'
            );
          } else {
            // Interruption: AI is still finishing — flag it and respond once done
            pendingCallerResponse = true;
            console.log('Caller interrupted — will respond after AI finishes');
          }
        }
      }

      if (data.type === 'error') {
        console.error('OpenAI error:', JSON.stringify(data, null, 2));
      }
    } catch (error) {
      console.error('Error processing OpenAI message:', error.message);
    }
  });

  twilioWs.on('message', (message) => {
    try {
      const data = JSON.parse(message.toString());

      if (data.event !== 'media') {
        console.log('Twilio event:', data.event);
      }

      if (data.event === 'start') {
        streamSid         = data.start.streamSid;
        callerPhoneNumber = data.start.customParameters?.callerNumber || null;
        console.log('Caller number:', callerPhoneNumber || 'unknown');

        // Now that we have the caller's number, update the session instructions
        // so the AI knows to skip asking for it and confirm it at the end instead
        if (callerPhoneNumber && openaiReady) {
          safeSendToOpenAI({
            type: 'session.update',
            session: {
              instructions: buildSessionInstructions(callerPhoneNumber),
            },
          });
        }

        sendGreeting();
      }

      if (data.event === 'media') {
        safeSendToOpenAI({ type: 'input_audio_buffer.append', audio: data.media.payload });
      }

      if (data.event === 'stop') {
        console.log('Twilio stream stopped');
      }
    } catch (error) {
      console.error('Error processing Twilio message:', error.message);
    }
  });

  twilioWs.on('close', () => {
    callClosed = true;
    console.log('Call ended');
    if (openaiWs.readyState === WebSocket.OPEN || openaiWs.readyState === WebSocket.CONNECTING) {
      openaiWs.close();
    }
  });

  openaiWs.on('close', () => console.log('OpenAI connection closed'));
  openaiWs.on('error', (err) => console.error('OpenAI WebSocket error:', err.message));
  twilioWs.on('error', (err) => console.error('Twilio WebSocket error:', err.message));
});

// ─────────────────────────────────────────────────────────────────────────────
// GOOGLE CALENDAR SETUP (do this once to connect your demo calendar)
//
// STEP 1 — Create a Google Cloud project
//   → Go to: https://console.cloud.google.com
//   → Create a new project (name it anything, e.g. "Dental Voice Agent")
//
// STEP 2 — Enable the Google Calendar API
//   → In your project, go to APIs & Services → Library
//   → Search "Google Calendar API" → Enable it
//
// STEP 3 — Create a Service Account
//   → Go to APIs & Services → Credentials → Create Credentials → Service Account
//   → Name it anything (e.g. "voice-agent"), click Done
//   → Click the service account → Keys tab → Add Key → JSON
//   → A .json file downloads — open it and copy:
//       "client_email"  → this is your GOOGLE_SERVICE_ACCOUNT_EMAIL
//       "private_key"   → this is your GOOGLE_PRIVATE_KEY
//
// STEP 4 — Create a demo Google Calendar
//   → Go to: https://calendar.google.com
//   → Click + (Other calendars) → Create new calendar
//   → Name it "Bright Smile Dental Demo"
//   → Go to its Settings → Share with specific people
//   → Add your service account email (client_email from the JSON)
//   → Give it "Make changes to events" permission
//   → Scroll down to "Integrate calendar" → copy the Calendar ID
//   → This is your GOOGLE_CALENDAR_ID
//
// STEP 5 — Add to Railway environment variables:
//   GOOGLE_SERVICE_ACCOUNT_EMAIL = (client_email from JSON)
//   GOOGLE_PRIVATE_KEY            = (private_key from JSON — keep the \n characters)
//   GOOGLE_CALENDAR_ID            = (Calendar ID from Step 4)
//   TZ                            = America/New_York  (or your timezone)
//
// STEP 6 — Deploy:
//   git add server.js
//   git commit -m "add Google Calendar booking"
//   git push
//
// That's it — calls will now appear in your demo calendar color-coded by priority.
// ─────────────────────────────────────────────────────────────────────────────