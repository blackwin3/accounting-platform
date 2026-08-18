# Maasai Pastoralist Business — Complete Two-Unit Entry Plan (v3)

A working instruction sequence for setting up and backdating two months of
realistic trading history for two brothers running a pastoralist herd near
Naivasha. This version combines the operational detail of v1 (phone, licence,
data costs, sanity-check totals) with the two-unit structure of v2 (HERD /
CATTLE), updated for every capability the platform gained through the Tier 2
work — insurance claims, loan closure, lease termination, stock verification,
and the period-end checklist.

---

## System state this plan is written against

Fifteen of seventeen operational cycles are now complete end-to-end. The two
that are not, and what that means for this plan:

- **Payroll** — the brothers do not employ anyone, so this gap does not
  affect them. If they later hire a herder, that wage goes through
  `Expenses → Salaries` as a single entry, with no payroll register or
  statutory deduction tracking.
- **Family inheritance** — no succession posting event exists yet. The
  Knowledge page can record intentions and decisions, but there is no
  accounting entry for a handover. This matters for these brothers in the
  long run and is explicitly Tier 3 work.

Everything else in this plan runs against genuinely working, tested routes.

---

## Why two units

**HERD** is the management layer — the two brothers as an economic entity.
Their capital, their living costs, their lodging on herding trips, the phone
that runs this platform, the platform licence, their drawings. The question
HERD answers: *what does it cost these two men to run this operation?*

**CATTLE** is the production layer — the animals. Registration, births,
deaths, milk, carcass sales, vet costs, insurance on the herd. The question
CATTLE answers: *does the herd pay for itself?*

Separating them forces both questions to be answerable independently. A
SACCO loan officer will ask the second question first. A brother deciding
whether to bring in a third partner needs the first.

---

## The three cost-allocation decisions, made explicitly

### 1. The vet cost — posted to CATTLE, narrated for both

The vet treats animals. The cost of keeping animals alive is an operating
cost of CATTLE. Posting it there means the HERD P&L stays clean (living
costs, phone, admin) and CATTLE's P&L shows the true cost of production.

The platform scopes every P&L view to the active business unit, so a vet
cost posted to CATTLE will not appear when viewing HERD. **This is correct
behaviour, not a missing entry.** The whole-business Journal and Trial
Balance show it regardless of which unit is active.

Add a Knowledge note when you post it (Step 9) so a successor or auditor
reading the HERD P&L later understands why there is no vet line there.

### 2. The phone — posted to HERD

The phone runs the accounting platform, sends receipts, and coordinates with
buyers and the vet. It is a management tool, not a cattle asset. HERD.

### 3. Insurance — posted to CATTLE

The herd is the insured asset. The premium belongs where the coverage sits.

---

## Insurance vs provision — using both, deliberately

These protect against genuinely different risks and the platform now handles
both cycles completely.

**Provision (self-insurance) — for routine, predictable vet care.**
Deworming, vaccination, wound treatment. The brothers set aside KES 10,000
under IAS 37. When the vet bill arrives, `postProvisionUtilisation` draws it
down rather than recognising a fresh expense. This is the honest accounting:
the cost hits the P&L when the obligation arises, not when cash leaves, so a
routine vet visit does not distort a month that was otherwise normal.

**Insurance — for catastrophic events.**
Herd disease outbreak, drought loss, theft of multiple animals. A livestock
policy transfers that risk to an insurer. The full cycle now works:

| Stage | Route | Status |
|---|---|---|
| Create policy | Claims → Risks & Insurance → Add Policy | Working |
| Pay premium | Claims → Expenses → Insurance (select policy from dropdown) | Working — links payment to the specific policy |
| **Record a claim payout** | `POST /api/insurance-policy/:id/claim` | **New in Tier 2** |
| Close / settle policy | Claims → Risks & Insurance → Close | Working |

The Risk Position panel on the Risks & Insurance page shows total coverage,
premiums due, a coverage ratio against asset carrying value, and warns when
a policy is within 30 days of expiry — a real risk for a herd whose owners
are away for weeks at a time.

---

## Step 1 — Business setup

1. Sign up and create the business.
2. **Organisation → Business**: Industry = *Agriculture / Livestock and Dairy*,
   Type = *Other*, Country = Kenya, Currency = KES.
3. **Business Units** — create exactly two:
   - `HERD` — the brothers' management layer
   - `CATTLE` — the herd itself

On save, the platform seeds all Catalogue event definitions, accounting
standards, and period-end checks for this business automatically. Visit
**Settings → Rules** afterwards to confirm — every cycle event should show
as a coloured chip against its governing standard.

---

## Step 2 — Open the backdated trading days

**Settings → Periods**. Open each day in your two-month window, in date
order, starting from the earliest. One period is shared across both units —
you do not open separate periods per unit.

Note: the period-end checklist now runs when you close a period. A period
with an out-of-balance Journal will refuse to close. This is intentional.

---

## Step 3 — Opening capital (unit: HERD)

Switch to **HERD**. **Money → Funds → Owner Capital Injection**, dated Day 1:

| Amount | Account | Note |
|---|---|---|
| KES 55,000 | Bank | "Opening bank balance — recent cattle sale proceeds plus combined savings" |
| KES 15,000 | Mobile Money | "Opening M-Pesa float" |
| KES 3,000 | Cash / Till | "Opening cash — small bills for daily trading" |

**Total: KES 73,000**

Then transfer working capital to CATTLE via **Money → Funds → Transfer**:
KES 50,000 from Bank to Bank (HERD → CATTLE context). This keeps each unit's
cash position honest and is a genuinely different accounting event from the
capital injection.

---

## Step 4 — Products and assets

### Products (unit: CATTLE)

| Product | Type | Price | Notes |
|---|---|---|---|
| Milk | Goods | KES 80/litre | Daily production, sold same day |
| Beef | Goods | KES 350/kg | Carcass sale, ~120 kg per animal |
| Goat Meat | Goods | KES 260/kg | ~70 kg per goat |
| Cattle (Zebu/Cross) | Goods | — | For the biological asset register |
| Goat | Goods | — | For the biological asset register |

### Asset (unit: HERD)

**Assets → Buy Asset**:

| Asset | Cost | Useful Life | Method | Payment |
|---|---|---|---|---|
| Android Phone | KES 7,000 | 3 years | Straight-Line | Cash or Mobile |

Note: "Digital library — runs the accounting platform, sends receipts to
buyers, coordinates with the vet."

Depreciation on this is KES 7,000 ÷ 36 = **KES 194/month**. Run it monthly
via **Assets → Post Depreciation** — the period-end checklist will warn you
if you forget.

---

## Step 5 — Register the herd (unit: CATTLE)

**Organisation → Livestock → Register Animal** for each animal worth
tracking individually — breeding cows, bulls, high-value goats. For each:

- Tag (ear tag number or the name the brothers actually use)
- Category: LIVESTOCK
- Sex: MALE or FEMALE (**required** — a birth can only be recorded against
  a FEMALE)
- Birth date if known
- **Fair value** — what this animal would realistically fetch at Naivasha
  market today. Even a rough figure is better than zero: this is the number
  used to compute the loss if the animal dies, and it feeds the insurance
  coverage ratio.
- Condition: GOOD / FAIR / POOR

Registration posts **no Journal entry** — entering the register is not the
same event as acquiring the animal. A purchased animal goes through Assets
or Expenses; a bred animal goes through `recordBirth`, which handles the
IAS 41 gain.

---

## Step 6 — Insurance and vet provision (unit: CATTLE)

### 6A — Livestock insurance policy

**Claims → Risks & Insurance → Add Insurance Policy**:

| Field | Value |
|---|---|
| Policy name | "Livestock Cover — Naivasha Herd" |
| Coverage amount | KES 300,000 (replacement value of the herd at market) |
| Premium | KES 18,000/year |
| Risk level | HIGH — the herd is the brothers' primary livelihood asset |
| Risk note | "Covers death, drought loss, disease outbreak, and theft. Insurer: [name]. Policy ref: [number]" |

Pay the first premium via **Claims → Expenses → Insurance**, selecting this
policy from the "Which Policy?" dropdown. The premium links back to the
policy record — this is the fix that closed the old gap where premiums
floated free of the policy they paid for.

### 6B — Vet provision

**Claims → Leases & Provisions → Add Provision**:

- Amount: KES 10,000
- Description: "Provision for routine veterinary costs — deworming, vaccination, wound treatment"

### 6C — Knowledge note

**Claims → Knowledge**, add:

> "Insurance premium (KES 18,000/yr) and vet provision (KES 10,000) are both
> charged to CATTLE, since the herd is the insured and treated asset. Both
> brothers agreed this at the start of the season. The HERD unit therefore
> shows no vet or insurance line — this is intentional, not a missing entry.
> Large or unexpected vet costs (disease outbreak, surgery) should trigger an
> insurance claim rather than additional provision."

---

## Step 7 — Daily and recurring entries

### A. Milk sale — CATTLE, most days

**Till → Sell**: 18–22 litres Milk @ KES 80. Vary the quantity day to day.
Payment: Cash or Mobile.
Expected: ~KES 1,600/day, **~KES 48,000/month**

### B. Living costs — HERD, daily

**Claims → Expenses → Other**: KES 2,000/day
Note: "Meals and subsistence, both brothers"
Expected: **~KES 60,000/month**

### C. Lodging — HERD, 3–4 nights/week when out with the herd

**Claims → Expenses → Other**: KES 500/night
Note: "Hotel — herding trip to [location]"
Expected: ~15 nights/month = **~KES 7,500/month**

### D. Phone and data — HERD, batched weekly

**Claims → Expenses → Utilities**: KES 350/week
(KES 30/day data + KES 20/day SMS ≈ KES 50/day)
Note: "Mobile data and SMS — receipts to buyers, vet coordination"
Expected: **~KES 1,400/month**

---

## Step 8 — Periodic sales (unit: CATTLE)

### Cattle sale — roughly every 10 days

**Till → Sell**: Beef, 120 kg @ KES 350 = **KES 42,000**
Payment: vary between Cash, Mobile, and Bank — butchers pay differently.
Note: "Sold to [butcher name] — weighed and paid on the spot"
Expected: 3/month = **~KES 126,000/month**

### Goat sale — roughly every 5 days

**Till → Sell**: Goat Meat, 70 kg @ KES 260 = **KES 18,200**
Payment: Cash or Mobile
Expected: 6/month = **~KES 109,200/month**

---

## Step 9 — One-time entries

### Platform licence (unit: HERD)

**Claims → Expenses → Other**: KES 3,000
Note: "6-month accounting platform licence"

This is recorded as a single upfront expense, not amortised month-by-month.
The platform has no prepaid-expense amortisation mechanism, so spreading it
across six months is not something the system can actually do. Recording it
as one cost is the honest choice.

### Vet costs when they occur (unit: CATTLE)

This is a **provision utilisation**, not a fresh expense — the cost was
already recognised in Step 6B.

**Claims → Leases & Provisions → Utilise Provision**:
- Select the KES 10,000 provision
- Amount: actual bill (e.g. KES 3,500 for deworming + vaccination)
- Payment: Cash or Mobile
- Result: provision drops to KES 6,500

**If the bill exceeds the provision** (e.g. emergency call-out at KES 15,000):
1. Utilise the full remaining provision first (draws it to zero)
2. Record the excess as a fresh **Expenses → Other**
3. Add a Knowledge note: "Emergency vet call exceeded provision by KES X.
   Review whether the insurance policy covers large veterinary events, or
   increase the provision next period."

---

## Step 10 — Livestock events (unit: CATTLE)

### Birth

**Organisation → Livestock → Record Birth**:
- Link to the mother's register record (must be FEMALE)
- Tag the newborn
- Fair value — what a newborn calf would fetch today (even KES 5,000 is
  better than zero)

Posts DR Biological Assets CR Gain on Biological Assets. Under IAS 41 new
stock appearing with no cash paid is genuine profit.

### Loss (death, disease, drought)

**Organisation → Livestock → Record Loss**:
- Type: DEATH_OR_SPOILAGE
- Reason: required — "East Coast Fever", "drought", "predation"

Posts DR Loss on Biological Assets CR Biological Assets at the animal's last
recorded fair value.

### Theft

Same route, type: THEFT. Posts to a separate Loss from Theft account and
flags HIGH risk with an alert — theft has a different pattern significance
than disease and the accounts are kept distinct deliberately.

### Insurance claim after a covered loss

If the loss is covered by the policy from Step 6A, record the payout once
the insurer pays:

`POST /api/insurance-policy/:id/claim` with the claim amount, payment method,
and `closePolicy: true` if this claim fully settles the policy.

Posts DR Bank CR Insurance Claim Income (4800) — genuinely income, not a
reversal of the premium expense. The premium bought coverage; the claim is
the coverage paying out.

Add a Knowledge note: "Claim lodged [date] for [animal tag], settled [date],
KES [amount] received. Policy ref [number]."

---

## Step 11 — Month-end routine

Run these at the end of each month, in this order:

1. **Post depreciation** on the phone — **Assets → Post Depreciation**
   (KES 194/month). The checklist will warn if you skip this.

2. **Verify stock quantities** — `GET /api/verify/stock-quantities`
   Compares system quantities against what the transaction record implies.
   Any discrepancy means stock moved outside the normal posting flow.

3. **Review the Risk Position** — Claims → Risks & Insurance
   Check the coverage ratio and whether the policy is nearing expiry.

4. **Run the period-end checklist** — `GET /api/periods/:id/checklist`
   Six checks: Journal balance (BLOCK), depreciation run (WARN), open
   receivables, provisions reviewed, insurance active, stock count.

5. **Close the period** — Settings → Periods → Close
   The checklist runs automatically. A BLOCK-severity failure refuses
   closure and tells you exactly what to fix.

---

## Sanity-check totals

### CATTLE — monthly

| Item | Amount |
|---|---|
| Milk sales (20L/day × 80 × 30) | +48,000 |
| Cattle sales (3 × 42,000) | +126,000 |
| Goat sales (6 × 18,200) | +109,200 |
| **Total income** | **+283,200** |
| Insurance premium (18,000 ÷ 12) | −1,500 |
| Vet provision charge (10,000 ÷ 3 months) | −3,333 |
| **Total operating costs** | **−4,833** |
| **CATTLE net** | **+278,367** |

### HERD — monthly

| Item | Amount |
|---|---|
| Living costs (2,000/day × 30) | −60,000 |
| Lodging (~15 nights × 500) | −7,500 |
| Phone and data (350 × 4 weeks) | −1,400 |
| Phone depreciation (7,000 ÷ 36) | −194 |
| Platform licence (3,000, one-time in month 1) | −3,000 |
| **HERD total (month 1)** | **−72,094** |
| **HERD total (month 2 onward)** | **−69,094** |

### Combined

Roughly **KES 278,000** generated by the herd against **KES 70,000** in
management and living costs. Genuinely profitable at this herd size, which
is what real pastoralism at this scale looks like when the numbers are
recorded honestly.

---

## What each view shows

| View | Content |
|---|---|
| **CATTLE P&L** | All sales, insurance, vet provision, births, deaths. The herd's real economics. |
| **HERD P&L** | Living costs, lodging, phone, licence, depreciation, capital. The management cost. |
| **Journal / Trial Balance** | Everything, both units combined. |
| **Risk Position** | Whole-business — policies and provisions regardless of active unit. |
| **Capital Position** | Whole-business — cash, capital, loans, investments. |
| **Asset Register Summary** | Whole-business — the phone appears here even when CATTLE is active. |

The vet cost appearing in the Journal but not in the HERD P&L is the system
working as intended. The Knowledge note from Step 6C is what makes that
legible to whoever reads these books next.

---

## What this plan cannot yet do

Stated plainly so nothing here is a surprise later:

- **Bulk planting** — if the brothers plant fodder at scale, each planting
  must be registered individually. Fine for a few plots, impractical for
  acres.
- **Payroll** — if they hire a herder, the wage is a single expense entry.
  No payslip, no PAYE/NHIF/NSSF tracking.
- **Succession** — no accounting event exists for handing the herd to a son
  or nephew. The Knowledge page can record the intention and reasoning;
  the transfer itself has no posting. This is the most significant remaining
  gap for a family pastoralist business and is explicitly Tier 3 work.
