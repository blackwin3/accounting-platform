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
- Name: "Toyota Vitz — KBX 123A"
- Cost: KES 600,000 (or purchase price)
- Useful life: 5 years
- Depreciation: Straight-Line
- Payment: Bank (or however it was financed)

**If on hire-purchase**: This is a lease, not an asset purchase.
Claims → Leases & Provisions → Record Lease:
- Total lease payments: KES 800,000
- Lease term: 3 years
- This creates a Right-of-Use Asset and Lease Liability (IFRS 16)

**If renting daily from a fleet owner**: This is a daily expense,
not an asset or lease. Record it as:
Claims → Expenses → Other: KES 1,500/day, "Vehicle hire — [fleet owner]"

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

**Record daily earnings as a labour charge**: This is optional but
powerful. Claims → Expenses → Other:
- Amount: the driver's own hourly rate × hours worked
- Note: "My time — 10 hours @ KES 100/hr = KES 1,000"

This makes the P&L show the driver's time as a cost. If revenue minus
all costs minus the driver's own time is negative, the driver is
literally paying to work.

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
| Rides (6–8 per day, avg KES 600) | +3,600–4,800 |
| Fuel (15–20 litres @ 200) | −3,000–4,000 |
| Food + water | −300 |
| Data | −100 |
| Bribes (0–2 per day) | 0–200 |
| **Daily net before vehicle costs** | **+0 to +1,200** |

### Monthly

| Item | Amount |
|---|---|
| Rides (26 working days × ~KES 4,000) | +104,000 |
| Fuel (26 × KES 3,500) | −91,000 |
| Food + water (26 × KES 300) | −7,800 |
| Data (30 × KES 100) | −3,000 |
| Bribes (est. 15 × KES 100) | −1,500 |
| Insurance | −3,000 |
| Repairs (amortised) | −3,000 |
| Vehicle depreciation (600K ÷ 60 months) | −10,000 |
| **Monthly net** | **−15,300** |

This is the honest picture that most Uber drivers in Nairobi don't
see: after all costs including vehicle depreciation, the typical driver
is losing money — the vehicle is depreciating faster than the rides earn.
The business only works if the driver:
1. Owns the vehicle outright (no depreciation charge)
2. Works more than 8 rides/day consistently
3. Gets above-average fares (airport runs, corporate accounts)

The platform makes this visible instead of hiding it behind "I made
4,000 today" which ignores the 3,500 in fuel that went with it.

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
