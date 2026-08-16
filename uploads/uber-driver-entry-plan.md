# Uber Driver Business — Single-Unit Entry Plan

A working instruction sequence for a Nairobi-based ride-hailing driver who
wants to know: **is this job actually worth it?** Not just "how much did I
earn today" but "after fuel, food, insurance, repairs, and bribes, did I
actually make money?"

---

## The honest economics

An Uber/Bolt/Little driver in Nairobi sees KES 3,000–6,000 appear in their
driver app daily. That looks like income. But it isn't — that's gross
revenue. The real question is what's left after:

- Fuel (the single largest cost, ~40% of revenue)
- Food and water (the driver eats on the road)
- Insurance (required by law, easy to forget to budget for)
- Repairs (tyres, oil, brakes — not "if" but "when")
- Bribes (a real, recurring, documentable cost in Nairobi)
- Phone data (the app runs on data)
- The driver's own time (what is an hour of your life worth?)

This plan tracks all of these so the driver can see, at the end of each
week, whether driving is genuinely more profitable than the alternatives.

---

## Step 1 — Business setup

1. Sign up: "Driver Enterprises", Industry = Transport, Kenya, KES.
2. Business Unit: `RIDES` (single unit — the driver IS the business).

---

## Step 2 — Products

### Services (what you sell — the ride)

| Product | Type | Category | Price | Unit | Notes |
|---|---|---|---|---|---|
| Ride — Distance | Service | Ride & Transport | KES 150 | trip | Per-trip distance component |
| Ride — Time | Service | Ride & Transport | KES 250 | trip | Time to destination |
| Ride — Pickup | Service | Ride & Transport | KES 50 | trip | Time to reach passenger |
| Ride — Occupancy | Service | Ride & Transport | KES 150 | person | Per-passenger charge |
| Ride — Traffic | Service | Ride & Transport | KES 25 | minute | Surge/traffic component |
| Ride — Convenience | Service | Ride & Transport | KES 50 | minute | Premium/comfort charge |

These aren't what Uber charges the customer — they're how the driver
**breaks down the fare mentally** to understand which component of each
ride earns the most. A short trip with heavy traffic (high Traffic, low
Distance) tells a different story than a long highway run (high Distance,
zero Traffic).

### Goods (what you consume)

| Product | Type | Category | Price | Cost | Unit |
|---|---|---|---|---|---|
| Fuel | Goods | Fuel | — | KES 100 | litre |
| Food | Goods | Food & Meals | — | KES 200 | meal |
| Water | Goods | Food & Meals | — | KES 50 | bottle |
| Vehicle Repair | Goods | Vehicle Parts | — | varies | job |
| Bribe | Goods | Other Goods | — | KES 100 | incident |

### Utilities

| Product | Type | Category | Cost | Unit |
|---|---|---|---|---|
| Phone Data | Utility | Data Bundle | KES 100 | day |
| Insurance Premium | Utility | Other Utility | varies | month |

---

## Step 3 — Opening capital

Money → Funds → Owner Capital Injection:

| Amount | Account | Note |
|---|---|---|
| KES 5,000 | Mobile Money | "Starting M-Pesa float — fuel and emergencies" |
| KES 2,000 | Cash / Till | "Cash for parking, tolls, bribes" |

Total: **KES 7,000**. This is deliberately small — the driver's real
asset is the vehicle, and whether that's owned or on hire-purchase
changes the economics entirely.

---

## Step 4 — The vehicle

**If owned**: Assets → Buy Asset:
- Name: "Toyota Vitz — KBX 123A" (include the registration to distinguish
  from a second vehicle if the driver manages one for a family member)
- Cost: KES 600,000 (or purchase price)
- Useful life: 5 years
- Depreciation: Straight-Line
- Payment: Bank (or however it was financed)

**If received as a gift or inheritance**: This is common — a brother gives
a vehicle, or a parent leaves one. The legal and accounting handling:
1. Register the vehicle at **KES 1** (the nominal legal transfer price —
   by law, a gift can be transferred at any amount including KES 1)
2. Have the vehicle **revalued to market price** immediately:
   Assets → Revalue Asset: new value KES 400,000 (whatever the market
   says today). This posts DR PPE CR Revaluation Surplus — the vehicle
   is now on the books at its real value.
3. The driver can then choose:
   - **Depreciate normally** over 5 years (correct accounting)
   - **Write off (impair) over the next few years** — post an impairment
     each year to gradually reduce the carrying amount. This is useful
     when the driver doesn't want a large depreciation charge hitting
     the P&L monthly. The accounting is: DR Impairment Loss CR PPE.
   The choice depends on what the driver needs the P&L to show — a
   bank wants to see depreciation, the driver's own planning may prefer
   impairment over time.

**If on hire-purchase**: This is a lease, not an asset purchase.
Claims → Leases & Provisions → Record Lease:
- Total lease payments: KES 800,000
- Lease term: 3 years
- This creates a Right-of-Use Asset and Lease Liability (IFRS 16)

**If renting daily from a fleet owner**: This is a daily expense,
not an asset or lease. Record it as:
Claims → Expenses → Other: KES 1,500/day, "Vehicle hire — [fleet owner]"

**If the driver manages a second vehicle** (e.g. his son drives it):
Register it as a second asset with a distinct name:
- "Toyota Vitz — KCD 456B (son's car)"
- The income from that vehicle can be tracked under the same RIDES unit
  — the product sales show which vehicle earned what if the receipts
  note which car made each trip.

---

## Step 5 — Insurance

Claims → Risks & Insurance → Record Policy:
- What is insured: "Vehicle — comprehensive + third party"
- How much are you covered for: KES 500,000
- How much do you pay: KES 3,000/month
- When does it start/expire: actual dates

Pay the premium monthly:
Claims → Expenses → Insurance (select the policy)

---

## Step 6 — Daily recording

### Morning

**Buy fuel**: Till → Buy, Fuel, litres purchased @ KES 200/litre.
Record every fuel stop — this is the single most important cost to track.

**Buy data**: Claims → Expenses → Utilities, Phone Data, KES 100.

### Each ride

Record as a **basket sale** with the component breakdown. Example ride:

Till → Sell:
- Ride — Distance: 1 × KES 150
- Ride — Time: 1 × KES 250
- Ride — Occupancy: 2 × KES 150 (two passengers)
- Ride — Traffic: 10 × KES 25 (10 minutes in traffic)

Total fare: **KES 800**

The driver doesn't need to enter every ride separately — batch them at
the end of the day if preferred. What matters is the totals for each
service component so the weekly P&L shows which types of rides earn the
most.

### During the day

**Food**: Claims → Expenses → Other, KES 200, "Lunch — [location]"
**Water**: Claims → Expenses → Other, KES 50
**Bribe**: Claims → Expenses → Other, KES 100, "Traffic police — [location]"

Record bribes honestly. They're a real, recurring operating cost. The
accountant and the driver both need to see how much is going to
corruption vs productive expenses. If a SACCO or cooperative ever
aggregates this data across drivers, the pattern becomes evidence.

### End of day

**Record daily earnings (what you take home)**: The driver takes out
whatever is left after fuel, food, data, and bribes. This is recorded
as a capital withdrawal — money leaving the business to the owner.

Money → Funds → Capital Withdrawal:
- Amount: KES 500–1,200 (whatever the day actually netted)
- Note: "Daily take-home — 8 hours driving"

The P&L then shows: revenue KES 4,000, costs KES 3,500, **net KES 500
remaining in the business** (or zero if the driver took it all).

**Optional — track your hourly rate for comparison**: Create a utility
product "My Time" at KES 750/hr. DON'T record it as an expense — use
it as a **mental calculator**: if today's net was KES 600 over 8 hours,
that's KES 75/hr. If a boda rider earns KES 150/hr, the driver can see
the rides need to improve or the costs need to drop.

The point is not to charge the business for the driver's time (that
would double-count — the driver IS the business). The point is to know
what the hourly rate works out to, so the driver can compare it to
alternatives.

---

## Step 7 — Weekly/monthly entries

### Vehicle maintenance

**Oil change**: Claims → Expenses → Other, KES 3,000, "Oil change — [garage]"
**Tyre**: Assets → Buy Asset (if it's a full set with multi-year life)
or Expenses → Other (if it's a single tyre replacement)
**Repair**: Claims → Expenses → Other, amount, "Brake pads — [garage]"

### Insurance and licence

Monthly insurance premium via the policy link.
Annual inspection, licence fees via Claims → Expenses → Other.

---

## Sanity-check totals

### Daily (typical)

| Item | Amount |
|---|---|
| Rides (6–8 per day, avg KES 600–750) | +4,000–6,000 |
| Fuel (15–20 litres @ 200) | −3,000–4,000 |
| Food + water | −300 |
| Data | −100 |
| Bribes (0–2 per day) | 0–200 |
| **Total operating costs** | **−3,500–4,500** |
| **Net available** | **+500–1,500** |
| Driver takes home (capital withdrawal) | −500–1,500 |
| **Remaining in business** | **~KES 0–1,500** |

### Monthly

| Item | Amount |
|---|---|
| Rides (26 working days × ~KES 5,000) | +130,000 |
| Fuel (26 × KES 3,500) | −91,000 |
| Food + water (26 × KES 300) | −7,800 |
| Data (30 × KES 100) | −3,000 |
| Bribes (est. 15 × KES 100) | −1,500 |
| Insurance | −3,000 |
| Repairs (amortised) | −3,000 |
| **Total operating costs** | **−110,300** |
| **Net before depreciation** | **+19,700** |
| Vehicle depreciation (600K ÷ 60 months) | −10,000 |
| **Business net before driver take-home** | **+9,700** |
| Driver takes home (26 × ~KES 500–1,000) | −13,000–26,000 |
| **Remaining in business** | **KES 0–1,500/month** |

The driver earns KES 130,000 gross from rides, spends KES 110,300 to
operate, and keeps KES 500–1,500 per day as take-home pay. What stays
in the business after the driver has been paid is roughly zero — the
business neither grows nor shrinks in cash terms.

But the vehicle depreciates KES 10,000/month regardless. This means the
driver's real wealth (cash + vehicle value) drops by roughly KES 10,000
per month unless the driver retains enough in the business to cover it.

**What the driver actually feels**: "I make KES 500–1,500 a day." That's
real money in his pocket. The platform shows him the full picture: after
fuel, food, data, insurance, repairs, and bribes, the rides leave
KES 0–1,500 per day. Over a month, the vehicle's value drops by
KES 10,000 which the driver doesn't feel but the accountant can see.

---

## What each view shows

| View | What the driver sees |
|---|---|
| **RIDES P&L** | Revenue by ride component (Distance, Time, Traffic, etc.) vs costs (fuel, food, insurance, repairs) |
| **Cash Flow** | Money in from rides, money out for fuel and expenses — the daily reality |
| **Fuel tracking** | Buy fuel as inventory purchase, consumed automatically on each ride day |
| **Asset Register** | The vehicle's depreciation schedule — how much value it loses each month |
| **Diagnostics** | Whether the books balance, whether any costs were missed |

---

## What this plan cannot yet do

- **Per-ride fuel consumption**: the platform tracks total fuel purchased
  and total rides sold, but doesn't automatically compute fuel per ride.
  The driver does this manually by dividing monthly fuel cost by ride count.
- **Uber app integration**: ride data must be entered manually. A future
  CSV import would eliminate the biggest data-entry burden.
- **Vehicle financing amortisation**: if the vehicle is on hire-purchase,
  the interest/principal split on each payment isn't automatic — use the
  loan repayment form with the interestAmount parameter.
