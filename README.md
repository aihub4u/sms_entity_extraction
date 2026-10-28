# SBI Transaction Complaint API (POC)

A stateless Node.js/Express API for SBI's WhatsApp complaint journey. It takes a bank SMS, a screenshot, or both, together with the customer's message (for example "I didn't do this transaction"). It returns the following:

- the transaction details SBI's tentative API needs: `txnNo, amount, date, time, merchant, account_card_det, txnType`
- additional data points the SMS carries, such as Dr/Cr, status, channel, reference type, beneficiary, deposit or bill number, and failure reason
- the complaint classification: intent, category, reason, customer confirmation, complaint type and escalation
- a list of fields that are still missing, each paired with a question the bot can ask the customer as written
- the request in SBI's current `JSON_COMPLAIN_REQ` format, plus an extended version that carries all the extra fields

**Extraction uses no regex and no SBI-specific templates.** OpenAI reads the message and returns a strict JSON schema (Structured Outputs). Newly whitelisted SMS templates therefore work without any code change. **There is no database.** Each call is self-contained, and the API never logs SMS content.

## How it works

```
POST /v1/transactions/extract
   │
   ├─ 1. OpenAI (Structured Outputs, strict JSON schema)
   │      classify message (alert / OTP / promo) · extract fields · detect customer intent
   │      (vision model also reads screenshots)
   │
   ├─ 2. Grounding check (deterministic)
   │      every ref no / account / amount / name must literally appear in the SMS,
   │      otherwise it is dropped and the customer is asked → no hallucinated references
   │
   ├─ 3. Normalise → SBI fields (date → 10-Aug-2026, amount → 500.00, time → HH:MM)
   │      apply values the customer supplied (`overrides`)
   │
   ├─ 4. Complaint rules (deterministic, auditable)
   │      intent + reason + txn mode/status → category, type, priority, escalation
   │
   └─ 5. Response: status, missing fields + bot questions, advisories, sbi_request(s)
```

The LLM only reports what the SMS and the customer said. Decisions are made in code (`src/services/complaintRules.js`), so the bank can review and tune them.

## Setup

```bash
cp .env.example .env      # add OPENAI_API_KEY and API_KEY
npm install
npm start                 # :3000
npm test                  # 12 tests, LLM stubbed (no key needed)
npm run samples           # runs all SMS from the Excel sheet against the running API (needs key)
```

`OPENAI_MODEL` defaults to `gpt-5.4-mini`. Any vision-capable model that supports `json_schema` strict mode works. For GPT-5.x reasoning models, set `OPENAI_REASONING_EFFORT=low` and leave `OPENAI_TEMPERATURE` blank. Set `OPENAI_BASE_URL` to use Azure OpenAI or a gateway.

Deploying to Render: `render.yaml` is included. Note that Render has no India region. If SBI requires in-country processing, host the service and the model endpoint (for example Azure OpenAI Central India) inside India.

## Endpoints

All `/v1` routes require the header `x-api-key: <API_KEY>` when `API_KEY` is set.

### `POST /v1/transactions/extract`

```json
{
  "twix_request_id": "664c2cb3f473982d64c36c55",
  "mobile_number": "919130548824",
  "sms_text": "Dear UPI user A/C X1282 debited by 106.00 on date 23Jun26 trf to RAMESH KEDARNATH Refno 388062945190 If not u? call-1800111109 for other services-18001234-SBI",
  "customer_message": "I didn't do this transaction",
  "image": { "base64": "<...>", "mime_type": "image/jpeg" },
  "overrides": { "time": "10:00" }
}
```

| Field | Required | Notes |
|---|---|---|
| `twix_request_id`, `mobile_number` | yes | Passed through to the SBI payload |
| `sms_text` | one of `sms_text` / `image` | Pasted or forwarded SMS |
| `image` | one of `sms_text` / `image` | `{url}` or `{base64, mime_type}`, for a screenshot of the SMS or app |
| `customer_message` | no | Free text from the customer, used to detect intent |
| `overrides` | no | Values the bot collected from the customer: `time`, `amount`, `txnNo`, `merchant`, `account_card_det`, `txnType`. Put the customer's answer about **when** the transaction happened into `time` exactly as typed: a time, a date, or both (see below) |

Response (UPI sample with "I didn't do this transaction", abridged):

```json
{
  "status": "NEEDS_INPUT",
  "ready_to_submit": false,
  "message_kind": "TRANSACTION_ALERT",
  "otp_detected": false,
  "transaction": {
    "txnNo": "388062945190", "amount": "106.00", "date": "23-Jun-2026", "time": null,
    "merchant": "RAMESH KEDARNATH", "account_card_det": "X1282", "txnType": "upi",
    "ref_type": "UPI_RRN", "currency": "INR", "dr_cr": "DR", "txn_status": "SUCCESS",
    "txn_description": "UPI Transfer", "channel": "UPI", "beneficiary_name": "RAMESH KEDARNATH"
  },
  "complaint": {
    "applicable": true, "intent": "RAISE_DISPUTE", "reason": "UNAUTHORISED_TRANSACTION",
    "customer_confirmation": { "code": "CUSTOMER_DENIES_TRANSACTION", "label": "Customer denies performing transaction" },
    "category": "UPI_DISPUTE", "category_label": "UPI Dispute",
    "complaint_type": "FRAUDULENT_DEBIT", "priority": "HIGH",
    "escalation_required": true, "escalation_reasons": ["Customer reports an unauthorised transaction"]
  },
  "missing_fields": ["time"],
  "follow_up_questions": [{ "field": "time", "question": "Around what time did the transaction happen? (for example, 10:30 AM)" }],
  "customer_advisories": [
    { "code": "BLOCK_CHANNEL", "text": "To stop further misuse, block your account/card/UPI now by calling 1800111109." },
    { "code": "CYBER_HELPLINE", "text": "Report the fraud on the national cyber-crime helpline 1930 or at cybercrime.gov.in. ..." }
  ],
  "warnings": [],
  "sbi_request": {
    "twix_request_id": "664c2cb3f473982d64c36c55",
    "mobile_number": "919130548824",
    "type": "JSON_COMPLAIN_REQ {\"txnNo\":\"388062945190\",\"amount\":\"106.00\",\"date\":\"23-Jun-2026\",\"time\":\"\",\"merchant\":\"RAMESH KEDARNATH\",\"account_card_det\":\"X1282\",\"txnType\":\"upi\"}"
  },
  "sbi_request_extended": { "transaction": { "...": "..." }, "complaint": { "...": "..." }, "source": { "fieldSource": { "txnNo": "sms", "time": null }, "fieldsUserProvided": [] } },
  "extraction": { "...": "raw model output after grounding; send back to /finalize" },
  "meta": { "model": "gpt-5.4-mini", "llm_latency_ms": 1840, "confidence": 0.96, "grounding": { "checked": true, "dropped": [] } }
}
```

`status` takes one of three values:
- `COMPLETE`: all `REQUIRED_FIELDS` are present.
- `NEEDS_INPUT`: ask the questions in `follow_up_questions`.
- `REJECTED`: the input is not a bank transaction message.

`ready_to_submit` is `true` only when the status is `COMPLETE` and the customer has expressed a complaint intent.

### `POST /v1/complaints/finalize`

This endpoint is the stateless follow-up and makes **no LLM call**. Send back the `extraction` object from `/extract` together with the answers the customer gave:

```json
{
  "twix_request_id": "664c2cb3f473982d64c36c55",
  "mobile_number": "919130548824",
  "extraction": { "...": "from /extract response" },
  "overrides": { "time": "10:00" },
  "sms_text": "(optional — re-runs the grounding check)"
}
```

It returns the same response shape as `/extract`.

### Free-text answers in `overrides.time`

`overrides` has no `date` parameter. Whatever the customer types about when the transaction happened goes into `overrides.time` exactly as typed. The API reads the date and/or the time from it.

| Customer types | Result |
|---|---|
| `7pm`, `7:30 PM`, `19:30`, `19.30`, `1930`, `around 10 am`, `noon` | time; parsed instantly, no LLM call |
| `24 June`, `24/06/2026`, `24-06-26`, `24Jun26`, `yesterday` | date (used only if the SMS had no date); time is then asked for next |
| `24/06/2026 6:40 pm`, `24th June 18.40`, `yesterday 7pm`, `6:40 pm on 24th June` | date and time; parsed instantly |
| `last Monday evening around 7`, `day before yesterday at 8` | resolved by OpenAI relative to today (IST) |
| `no idea`, `evening` (no hour) | not resolvable: returns an `INVALID_OVERRIDE` warning and the same follow-up question |

When the SMS has no date, `missing_fields` lists both `date` and `time`, but `follow_up_questions` has a **single** entry with `field: "time"` that asks for both. The bot always puts the answer into `overrides.time`. A date the customer types never replaces a date that came from the SMS.

Numeric dates are read day-first (Indian format). A date with no year is taken as the most recent past occurrence.

### `POST /v1/complaints/submit`

Send the `sbi_request` object from a `COMPLETE` response to this endpoint. If `SBI_COMPLAINT_API_URL` is set, the request is forwarded to SBI's API. If it is not set, the endpoint returns a mock acknowledgement (`complaint_id: "MOCK…"`), which lets the POC run end to end without SBI's API.

### `GET /health`

Returns a basic health check.

## Bot flow (Karix WhatsApp sandbox)

1. The customer pastes an SMS or sends a screenshot. Call `/extract` with their message.
2. Send each entry in `customer_advisories` immediately. These include the block-card and 1930 guidance for fraud and the warning when an OTP was shared.
3. If `NEEDS_INPUT`, ask the questions in `follow_up_questions` one by one, then call `/finalize` with `extraction` and the `overrides` collected from the customer.
4. When the result is `COMPLETE`, show the customer a confirmation summary built from `transaction` and `complaint`, then call `/submit` and send the customer the complaint ID.

The bot keeps the `extraction` object in its own conversation state, for example in the Karix flow variables. This API stores nothing.

## Safeguards

- **OTP messages** are detected as `message_kind: "OTP"`. The OTP digits are never returned. A test asserts this. The bot asks for the debit SMS instead.
- **Grounding**: identifiers that do not appear verbatim in the SMS are dropped and reported in `warnings` as `UNGROUNDED_VALUE_DROPPED`.
- **Prompt injection**: the prompt treats SMS and customer text as data, never as instructions.
- **No storage or PII logging**: access logs record only the request ID, path, status and latency. The extended payload carries a SHA-256 hash of the SMS, never the SMS itself.
- **Sanity checks**: warnings are raised for future dates, transactions older than `MAX_TXN_AGE_DAYS`, non-INR amounts (SBI's API has no currency field), and invalid overrides.

## Configuration of business rules

| Env | Default | Purpose |
|---|---|---|
| `REQUIRED_FIELDS` | `txnNo,amount,date,time,account_card_det,txnType` | Fields needed before `COMPLETE`. `merchant` is optional because IMPS, SWIFT and TDR alerts don't carry one |
| `ESCALATION_AMOUNT_THRESHOLD` | `100000` | Amounts at or above this value set priority to HIGH and escalate |
| `MAX_TXN_AGE_DAYS` | `365` | Older transactions produce a warning |
| `BANK_HELPLINE` | `1800111109` | Number used in the fraud advisory |

## Open points for SBI

1. The accepted `txnType` values. This API sends lowercase modes: `upi, imps, neft, rtgs, intrabank, swift, tdr, rd, fastag, bill_payment, card, atm, mandate, prepaid_card, insurance_premium, mcash, donation, other`.
2. Whether `time` is mandatory. No SBI SMS sample contains a time.
3. Whether SBI will adopt the extra fields shown in `sbi_request_extended`.
4. The response contract of the complaint API (complaint ID, TAT, status-check).
5. Approved LLM hosting and data-residency requirements.

## Project layout

```
src/
  server.js                 entry point
  app.js                    routes, auth, error handling
  config.js                 env config
  validation.js             request schemas (zod)
  llm/schema.js             strict JSON schema for the model
  llm/prompt.js             format-agnostic extraction prompt
  llm/openaiExtractor.js    OpenAI call (Structured Outputs, vision)
  services/grounding.js     anti-hallucination check
  services/normalize.js     date/time/amount normalisation
  services/complaintRules.js category, type, escalation, advisories
  services/processor.js     builds the response + SBI payloads
samples/sms-samples.json    SMS from the shared Excel
scripts/run-samples.js      live run over all samples
test/api.test.js            API tests with stubbed LLM
```
