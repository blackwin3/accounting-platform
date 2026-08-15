# Maasai Pastoralist Business — Two-Unit Entry Plan (v2)

A working instruction sequence for setting up and backdating 2 months of
realistic trading history across two genuinely distinct business units:
**HERD** (the brothers' management overhead, living costs, and capital) and
**CATTLE** (the herd itself — animals as biological assets, sales, milk,
and vet costs). Follow in order — later steps depend on earlier ones.

---

## Why two units, and what each one does

This business is genuinely two interlocking operations. A bank officer, a
visiting accountant, or a successor needs to see them separately before they
can understand them together:

**HERD** is the holding/management layer — what it costs the brothers to run
their lives as pastoralists. Living costs, lodging, the phone, the licence,
their capital injections and drawings. The income side of HERD is not the
sale of animals directly — that belongs to CATTLE — but any management fee
or profit transfer between units would flow through here.

**CATTLE** is the operational/production layer — everything that happens to
the animals themselves. Animal registration, births and deaths, milk
production and sale, cattle and goat carcass sales, and all vet-related
costs. The income that makes this business work — KES 283,400/month in a
normal month — flows through CATTLE, not HERD.

The split forces an honest answer to the question "does the herd pay for
itself, before counting the brothers' own living costs?" and "what does it
actually cost to keep these animals alive?" — the two questions a banker or
cooperative lender would ask first.

---

## The vet cost question — three honest options

A vet visit serves the whole business. There is one payment. The platform
currently scopes every view to the active business unit, which means a
cost posted to CATTLE is invisible when viewing HERD and vice versa. This
is not a bug — it is the correct behaviour for a business that genuinely
wants separate unit P&Ls. But it creates a real design question for shared
costs.

**Option A — Post the full cost to CATTLE (recommended).**
The vet comes to treat animals. The cost of keeping animals alive is an
operating cost of CATTLE, full stop. The HERD unit then sees its own
position clearly (capital contributed, drawings taken, phone and admin
costs) without vet noise. This is the most honest accounting: the cost sits
where the benefit sits. The HERD-level owner summary should simply show the
transfer of net profit from CATTLE as the income line, not re-display
CATTLE's individual costs.

**Option B — Split the vet cost across both units.**
Post half to CATTLE (animal care) and half to HERD (management overhead,
on the grounds that healthy animals mean the brothers keep their jobs). In
practice this is a fudge — the split is arbitrary, and an accountant seeing
it will ask what principle drove the 50/50. Only use this if the brothers
have an actual documented cost-sharing agreement.

**Option C — Post to CATTLE, add a Narrative note visible to both.**
Post the full cost to CATTLE. Add a Knowledge or Narrative entry (the
platform's `Knowledge` table, accessible from the Knowledge page) explaining
that the vet cost was a shared operational expense. This is the honest
version of Option B: the accounting is clean (one entry, correct unit), and
the institutional memory is preserved without inventing a fictitious split.

**This plan uses Option A + C combined:** full cost to CATTLE, narrative note
for the institutional record.

---

## The insurance / savings (provision) question

There are two structurally different ways the brothers might protect against
a large vet bill:

**Insurance route:** Take out a livestock insurance policy (available from
some Kenyan insurers and SACCOs for named herds). The premium is paid
annually or semi-annually. If an animal dies or requires expensive
treatment, the insurer pays a claim.

In the platform:
1. Record the policy — **Claims → Risks & Insurance → Add Insurance Policy**,
   Instrument_type = INSURANCE, coverage amount = estimated herd value.
2. Pay each premium — **Claims → Expenses → Insurance** (link to the policy
   via the "Which Policy?" dropdown so the premium is genuinely recognized
   against the policy, not just as a floating expense).
3. When a claim is paid out — for now, record it as **Money → Funds → Unit
   Income** (category = OTHER, note "Insurance claim — vet/death payout").
   This is the Tier 2 gap identified in the cycle evaluation: a dedicated
   claim posting route does not yet exist.

Post the insurance premium to **CATTLE** (the herd is what's insured) and
add a Knowledge narrative noting the policy details. The Risk Position
panel on the Risks & Insurance page will surface the coverage ratio
(insurance cover ÷ asset carrying value) once animals are registered as
biological assets.

**Provision / self-insurance route (what the original plan used):**
The brothers set aside KES 10,000 as a Warranty Provision (IAS 37 — an
estimated future obligation recognized now). When the actual vet bill
arrives, `postProvisionUtilisation` draws down that provision rather than
recognising a fresh expense. This is the honest accounting for a business
that self-insures: the cost hits the P&L when the obligation arises
(provision), not when the cash leaves (drawdown), which prevents the vet
bill from looking like a surprise hit on a month that was otherwise good.

This plan keeps **both**: a provision for routine vet care (predictable,
recurring, manageable), and an insurance policy note for catastrophic events
(herd disease, drought, large-scale losses). A small SACCO or Maasai
cooperative would recognise both as prudent practice.

---

## Step 1 — Business Setup

1. Sign up / create the business.
2. **Organisation → Business**: Industry = *Agriculture / Livestock and Dairy*,
   Type = *Other*, Country = Kenya, Currency = KES.
3. **Business Units** — create exactly two:
   - `HERD` — the brothers' management layer (capital, living costs, phone, admin)
   - `CATTLE` — the herd itself (animals, milk, sales, vet costs)

Note: the platform will prompt you to switch between HERD and CATTLE when
posting each entry. Read each step below carefully for which unit to be in.

---

## Step 2 — Open the backdated trading days

Open each day in your 2-month window under **Settings → Periods** before
posting any transactions. Days must be opened in date order. One period is
shared across both units — you do not open separate periods per unit.

---

## Step 3 — Opening Capital (unit: HERD)

Switch to the **HERD** unit. The brothers' capital belongs to the management
layer — they inject money into the business, which HERD then makes available
to CATTLE's operations.

Post on **Day 1** via **Money → Funds → Owner Capital Injection**:

| Amount | Account | Note |
|---|---|---|
| KES 55,000 | Bank | "Opening bank balance — recent cattle sale proceeds, combined savings" |
| KES 15,000 | Mobile Money | "Opening M-Pesa balance — business float" |
| KES 3,000 | Cash / Till | "Opening cash — small bills for daily trading" |

Total opening capital: **KES 73,000** — injected into HERD.

If the brothers intend to run the operations through CATTLE, do a
**Fund Transfer** (Money → Funds → Transfer) from HERD to CATTLE of whatever
working capital CATTLE needs (e.g. KES 50,000 to Bank, leaving KES 23,000
in HERD for admin costs). This transfer is a genuinely different accounting
event from the capital injection and keeps the two units' cash positions
honest.

---

## Step 4 — Products and Assets

### Products (unit: CATTLE)

Switch to **CATTLE**. Create these on the Products page:

| Product | Type | Price | Notes |
|---|---|---|---|
| Milk | Goods | KES 80/litre | Daily production. Adjust daily quantity to actual litres per herd. |
| Beef (live weight equivalent) | Goods | KES 350/kg | Carcass sale to butcher — approx 120 kg per animal. |
| Goat Meat | Goods | KES 260/kg | Approx 70 kg per goat at slaughter. |

Also create under CATTLE — Livestock products for the biological asset register:

| Product | Type | Notes |
|---|---|---|
| Cattle (Zebu/Cross) | Goods | One product record per breed in the herd. |
| Goat | Goods | One product record for the goat herd. |

### Assets (unit: HERD)

Switch to **HERD**. The phone is a management tool, not a cattle asset.

| Asset | Cost | Useful Life | Notes |
|---|---|---|---|
| Android Phone | KES 7,000 | 3 years | "Platform access, receipts, WhatsApp to buyers and vet" |

---

## Step 5 — Register the Herd (unit: CATTLE)

Switch to **CATTLE**. Use **Organisation → Livestock → Register Animal** for
each animal worth individually tracking (breeding cows, bulls, high-value
goats). For herd animals not individually tagged, a single group product
registration is sufficient.

For each individually-tracked animal, record:
- Tag/identifier (ear tag number or local name)
- Category: LIVESTOCK
- Sex: MALE or FEMALE (required for birth tracking)
- Birth date (if known)
- Fair value at registration date (what you could realistically sell it for)
- Condition: GOOD / FAIR / POOR

These registrations post **no Journal entries** — entering the register is not
the same accounting event as acquiring the animal. If the animal was
purchased, the purchase goes through Assets or Expenses. If the animal was
bred by the herd itself, recordBirth handles the IAS 41 gain recognition.

---

## Step 6 — Insurance Policy and Vet Provision (unit: CATTLE)

Both the insurance policy and the vet provision protect the herd. Both go
to CATTLE.

### 6A — Insurance Policy

Under **Claims → Risks & Insurance → Add Insurance Policy**:

| Field | Value |
|---|---|
| Policy name | "Livestock Cover — Naivasha Herd" |
| Coverage amount | KES 300,000 (estimated replacement value of the herd at current market prices) |
| Premium amount | KES 18,000/year (KES 1,500/month reference — adjust to actual quote) |
| Risk level | HIGH (a herd is the brothers' primary livelihood asset) |
| Risk note | "Covers death, drought loss, and disease outbreaks. Insurer: [name]" |

When the first premium is due, pay it under **Claims → Expenses → Insurance**,
select this policy from the "Which Policy?" dropdown. The platform links the
payment back to the policy and clears the `Outstanding_Amount` on the policy
row — this is the feature built this session to close the gap in the old
flow.

Post the premium to **CATTLE**. Add a Knowledge note:
"Insurance premium covers the whole herd and is charged to CATTLE since
the herd is the insured asset. Both brothers are aware this is a shared
operational cost."

### 6B — Vet Provision

Under **Claims → Leases & Provisions → Add Provision**:

| Field | Value |
|---|---|
| Amount | KES 10,000 |
| Description | "Provision for routine veterinary costs — deworming, vaccination, wound treatment" |

This recognises the expected vet cost now (IAS 37: the obligation exists
even though the vet hasn't visited yet). Post to **CATTLE**.

Add a Knowledge note under **Claims → Knowledge**:
"Vet provision of KES 10,000 set aside for routine herd care. Large or
unexpected vet costs (disease outbreak, surgery) should trigger a review
of the insurance policy's claim process rather than additional provision.
Both brothers agreed to this at the start of the current season."

---

## Step 7 — Daily / Recurring Entries

### Milk sales (unit: CATTLE, daily-ish)

Switch to **CATTLE**. Under **Till → Sell**:
- Product: Milk, 18–22 litres (vary for realism) @ KES 80
- Payment: Cash or Mobile (buyer pays immediately)
- Expected: ~KES 1,600/day, ~KES 48,000/month

### Living costs (unit: HERD, daily)

Switch to **HERD**. Under **Claims → Expenses → Other**:
- KES 2,000/day — "Meals and subsistence, both brothers"
- Payment: Cash

### Lodging (unit: HERD, when incurred)

Switch to **HERD**. Under **Claims → Expenses → Other**:
- KES 500/night — "Hotel during herding trip to [location]"
- 3–4 nights/week when moving the herd; fewer when settled at the ranch

### Phone/data costs (unit: HERD, weekly batch)

Switch to **HERD**. Under **Claims → Expenses → Utilities** (or Other):
- KES 350/week — "Mobile data and SMS — receipts, buyers, vet coordination"

---

## Step 8 — Periodic Entries

### Cattle sales (unit: CATTLE, roughly every 10 days)

Switch to **CATTLE**. Under **Till → Sell**:
- Product: Beef, 120 kg @ KES 350 = **KES 42,000**
- Payment: vary between Cash, Mobile, Bank (butchers pay in different ways)
- Note: "Sold to [butcher name] — weighed and paid on the spot"

### Goat sales (unit: CATTLE, roughly every 5 days)

Switch to **CATTLE**. Under **Till → Sell**:
- Product: Goat Meat, 70 kg @ KES 260 = **KES 18,200**
- Payment: Cash or Mobile

---

## Step 9 — Vet Costs when they actually occur (unit: CATTLE)

When the vet visits and the bill arrives, this is a **provision utilisation**,
not a fresh expense — the cost was already recognised in Step 6B.

Under **Claims → Leases & Provisions → Utilise Provision**:
- Select the KES 10,000 provision created in Step 6B
- Amount: actual vet bill (e.g. KES 3,500 for deworming + vaccination)
- Payment: Cash or Mobile
- This draws down the provision by KES 3,500, leaving KES 6,500 still in reserve

If the bill **exceeds** the provision (e.g. an emergency call-out at KES
15,000 when the provision is KES 10,000):
1. Utilise the full KES 10,000 provision first (draws it to zero).
2. Record the remaining KES 5,000 as a fresh **Expense → Other** (it's now a
   genuine unexpected cost beyond what was anticipated).
3. Add a Knowledge note: "Emergency vet call — exceeded provision by KES 5,000.
   Consider increasing the provision next period, or reviewing whether the
   insurance policy covers large veterinary events."

**Cross-unit visibility note:** The vet utilisation posts to CATTLE. When
viewing the HERD unit, the vet cost does not appear in the HERD expense list
— this is correct, not a missing entry. The vet treated animals, not the
management entity. The HERD unit's clean P&L (living costs, phone, admin)
vs CATTLE's operational P&L (sales less vet, insurance, animal losses) is
exactly what the two-unit split is supposed to produce.

---

## Step 10 — One-time Entries

### Phone purchase (unit: HERD)

Switch to **HERD**. Under **Assets → Buy Asset**:
- Asset name: Android Phone, KES 7,000, useful life 3 years
- Payment: Cash or Mobile
- Depreciation method: Straight-Line

### Platform licence (unit: HERD)

Switch to **HERD**. Under **Claims → Expenses → Other**:
- KES 3,000 — "6-month accounting platform licence"
- Note: recorded as a one-time expense, not amortised month-by-month

### Animal births (unit: CATTLE)

When a calf or kid is born, switch to **CATTLE** and use
**Organisation → Livestock → Record Birth**:
- Link to the mother's register record (she must be marked FEMALE)
- Assign a tag to the newborn
- Set a fair value (what would this animal fetch at market today? Even
  a rough estimate like KES 5,000 for a newborn calf is better than zero)
- The platform posts DR Biological Assets CR Gain on Biological Assets
  (IAS 41 — new stock appearing with no cash paid is genuine profit under
  this standard)

### Animal loss (unit: CATTLE)

If an animal dies or is stolen, switch to **CATTLE** and use
**Organisation → Livestock → Record Loss**:
- Select DEATH_OR_SPOILAGE (disease, drought, injury) or THEFT
- Enter the reason (required for audit trail)
- The platform posts DR Loss on Biological Assets CR Biological Assets at
  the animal's last recorded fair value
- If the loss is covered by the insurance policy (Step 6A), separately
  record the claim payout as income once it's received (Step 11)

---

## Step 11 — Insurance Claim Payout (unit: CATTLE, when it happens)

If a significant loss triggers a successful insurance claim and the insurer
pays out, record the receipt under **Money → Funds → Unit Income** with a
clear note linking it back to the policy and the animal lost.

This is the Tier 2 gap in the current system — there is no dedicated claim
posting route yet. Unit Income is the closest available path. When the
dedicated claim route is built (future development), it will link directly
to the policy's Money row and update its settlement status.

Knowledge note to add: "Insurance claim lodged on [date] for [animal tag].
Settled [date], KES [amount] received. Policy number [ref]."

---

## Sanity-check totals by unit

### CATTLE (monthly)

| Item | Monthly |
|---|---|
| Milk sales (20L/day × KES 80 × 30) | ~KES 48,000 |
| Cattle sales (3 × KES 42,000) | ~KES 126,000 |
| Goat sales (6 × KES 18,200) | ~KES 109,200 |
| **Total CATTLE income** | **~KES 283,200** |
| Insurance premium (KES 18,000/year ÷ 12) | ~KES 1,500 |
| Vet provision charge | ~KES 3,333 (KES 10,000 ÷ 3 months) |
| **Total CATTLE operating costs** | **~KES 4,833** |
| **CATTLE net** | **~KES 278,367/month** |

### HERD (monthly)

| Item | Monthly |
|---|---|
| Living costs (KES 2,000/day × 30) | ~KES 60,000 |
| Hotel/lodging (varies — est. 15 nights) | ~KES 7,500 |
| Phone/data (KES 350 × 4 weeks) | ~KES 1,400 |
| Phone depreciation (KES 7,000 ÷ 36 months) | ~KES 194 |
| Platform licence (KES 3,000 ÷ 6 months) | ~KES 500 |
| **Total HERD costs** | **~KES 69,594** |

The brothers' drawings (KES 60,000/month living costs) come from HERD.
CATTLE's surplus funds HERD through periodic Fund Transfers. At full run
rate the business generates roughly KES 278,000 from cattle operations
against KES 70,000 in management/living costs — genuinely profitable at
scale, which is what real Maasai pastoralism at this herd size looks like.

---

## Cross-unit vet cost — what each view shows

This is the question the two-unit split surfaces most clearly:

| View | What you see |
|---|---|
| **CATTLE P&L** | Insurance premium, vet provision, vet utilisation, animal births/deaths, all sales. A complete picture of herd economics. |
| **HERD P&L** | Living costs, phone, admin, capital injections and drawings. A complete picture of management costs. |
| **Whole-business view** (Journal / Trial Balance) | Both units combined — the vet cost appears here regardless of which unit posted it. |
| **Risk Position panel** (Risks & Insurance page) | Insurance policies and provisions from the whole business — not scoped to a single unit — so the livestock policy's coverage ratio shows regardless of which unit is active. |

The vet cost is visible from HERD via the whole-business Journal/Trial
Balance but intentionally absent from the HERD P&L. This is not a missing
entry — it is the correct behaviour for a unit-separated P&L. The Knowledge
note added in Step 6B is the institutional explanation that makes this
legible to a successor or auditor who wonders why the HERD P&L has no vet
line.
