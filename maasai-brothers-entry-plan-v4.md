# Maasai Pastoralist Business — Two-Unit Entry Plan (v4)

A working instruction sequence for two brothers running a pastoralist herd
near Naivasha. This version restructures the unit economics to reflect what
actually happens: the brothers live off the milk, sell cattle and goats to
make up the difference, and their real wealth is the herd itself — a high-
value asset portfolio that happens to walk around and eat grass.

---

## The honest economics, stated upfront

These brothers are not running a dairy. They are managing a **living asset
portfolio** that produces a small daily income (milk) which is never enough
to cover their living costs. The shortfall is covered by periodically
liquidating one asset (selling a goat or a cow to the butcher). Their real
financial position is: modest monthly cash loss, enormous asset base.

This is exactly the shape a bank loan officer needs to see honestly:
- **HERD unit**: the brothers as managers. Milk income, living costs,
  phone, admin. Shows a monthly **loss** of roughly KES 22,000 — the gap
  between what the milk earns and what it costs to live.
- **CATTLE unit**: the herd as an asset register. Animal registrations at
  fair value, births (new assets appearing), deaths (assets lost), and
  periodic sales to the butcher. The cattle sales **cover the HERD loss**
  and produce the brothers' actual take-home income.

The accountant's job is to explain to the brothers (who don't need to
understand double-entry) that their monthly living costs exceed their milk
income by KES 22,000, and that every goat or cow they sell is them drawing
down their own asset base to fund the gap — which is fine as long as the
herd is growing (births exceed sales + deaths) and the fair value of the
herd is rising.

---

## Unit structure — what goes where and why

| Item | Unit | Why |
|---|---|---|
| Milk sales | **HERD** | Milk sustains the brothers. It is the recurring income that pays for meals, lodging, and the phone. Putting it in HERD makes the management-cost gap visible. |
| Cattle/goat sales to butcher | **CATTLE** | Selling an animal is liquidating an asset. The proceeds go to CATTLE first, then transfer to HERD as needed. |
| Living costs, lodging, phone, data | **HERD** | Management overhead. |
| Animal registration (fair value) | **CATTLE** | The animals are the asset base. Each registered animal's fair value appears on the balance sheet under Biological Assets. |
| Vet costs, insurance | **CATTLE** | Protects and maintains the asset base. |
| Grazing/field access fees | **CATTLE** | A direct operating cost of keeping the herd alive. |
| Births | **CATTLE** | New assets appearing — IAS 41 fair value gain. |
| Deaths/theft | **CATTLE** | Assets lost — recorded as a loss against the herd's value. |
| Platform licence | **HERD** | Admin tool. |
| Phone (asset) | **HERD** | Management tool. |

---

## How animals are valued — registration as biological assets

Each animal is registered via **Organisation → Livestock → Register Animal**
with a **fair value** — what this specific animal would realistically fetch
at Naivasha market today, alive. This is the IAS 41 fair value model for
biological assets: the herd's value is what the market would pay for it
today, not what the brothers originally paid (which for bred animals is
zero).

**The question: HERD or CATTLE?** The animals are registered in **CATTLE**
because that is where births, deaths, reviews, and sales are tracked. But
the balance sheet shows them business-wide — so when the accountant pulls
the Asset Register Summary or the Balance Sheet, the full herd value appears
regardless of which unit is active.

**Fair value estimation for a Maasai herd near Naivasha** (adjust to actual
market knowledge):

| Animal | Estimated fair value (alive, at market) |
|---|---|
| Mature Zebu cow (breeding, lactating) | KES 60,000–80,000 |
| Mature Zebu bull | KES 70,000–100,000 |
| Heifer (1–2 years, not yet bred) | KES 35,000–50,000 |
| Calf (under 1 year) | KES 15,000–25,000 |
| Mature goat (breeding doe) | KES 8,000–12,000 |
| Billy goat | KES 10,000–15,000 |
| Kid (under 6 months) | KES 3,000–6,000 |

A herd of 20 cattle and 15 goats at these values has a total fair value
of roughly **KES 1,000,000–1,500,000** — the brothers' real wealth. The
monthly cash loss of KES 22,000 on the HERD P&L looks very different when
the balance sheet shows over a million shillings in biological assets.

---

## The sell-to-butcher cycle — asset disposal, not a shop sale

When the brothers sell a cow to the butcher, this is not a retail sale (Till
→ Sell). It is the **disposal of a biological asset** — the animal leaves the
register, its fair value leaves the balance sheet, and the difference between
the sale proceeds and the carrying value is a gain or loss.

The platform handles this through two steps:
1. **Record the sale**: Till → Sell (Beef, 120 kg @ KES 350 = KES 42,000).
   This posts the cash receipt and the revenue. Posted to **CATTLE**.
2. **Remove the animal from the register**: Organisation → Livestock →
   Record Loss (reason: "Sold to butcher [name]", type: DEATH_OR_SPOILAGE
   — the animal is no longer alive, regardless of the reason). This posts
   the fair value write-off against the Biological Assets account.

The net effect: KES 42,000 cash received, KES 60,000–80,000 fair value
removed from the balance sheet. If the sale price is below the registered
fair value, the difference is a **real loss** that appears on the P&L. This
is honest: selling a cow worth KES 75,000 for KES 42,000 of meat means the
brothers chose liquidity over value, which is exactly what periodic asset
liquidation to fund living costs looks like.

**Inter-unit transfer**: the KES 42,000 sale proceeds sit in CATTLE's cash.
The brothers transfer what they need to HERD via **Money → Funds → Transfer**
(Cash or Mobile, CATTLE → HERD). This is not a "purchase" — it is the
management entity drawing on the herd's earnings, exactly as it would be if
the herd were a subsidiary and HERD were the holding company.

---

## Grazing and field access fees

If the brothers pay for access to grazing land (a common arrangement in
Naivasha's pastoral economy — ranchers charge per head per month, or a flat
seasonal fee), this is a **CATTLE operating cost**:

**Claims → Expenses → Other**: KES 5,000/month (adjust to actual)
Note: "Grazing access — [rancher name]'s field, [location], [number] head"
Unit: **CATTLE**

This reduces CATTLE's apparent profit and makes the unit economics more
realistic: the herd doesn't graze for free.

---

## Step-by-step entry plan

### Step 1 — Business setup

1. Sign up. Industry = *Agriculture / Livestock and Dairy*, Kenya, KES.
2. Business Units: `HERD` and `CATTLE`.

### Step 2 — Open backdated trading days

Settings → Periods. Open each day in your two-month window, date order.

### Step 3 — Opening capital (unit: HERD)

Money → Funds → Owner Capital Injection, Day 1:

| Amount | Account | Note |
|---|---|---|
| KES 55,000 | Bank | "Opening bank balance" |
| KES 15,000 | Mobile Money | "Opening M-Pesa float" |
| KES 3,000 | Cash / Till | "Opening cash" |

Total: **KES 73,000** into HERD.

No inter-unit transfer at setup. The brothers start operations from HERD's
cash. When CATTLE makes its first sale, the proceeds sit in CATTLE until
they choose to transfer them to HERD.

### Step 4 — Products

**Unit: CATTLE** — Products page:

| Product | Type | Price | Notes |
|---|---|---|---|
| Beef | Goods | KES 350/kg | Carcass weight ~120 kg |
| Goat Meat | Goods | KES 260/kg | ~70 kg per goat |
| Cattle (Zebu/Cross) | Goods | — | For the biological asset register |
| Goat | Goods | — | For the biological asset register |

**Unit: HERD** — Products page:

| Product | Type | Price | Notes |
|---|---|---|---|
| Milk | Goods | KES 80/litre | Daily production, sustains the brothers |

### Step 5 — Register the herd (unit: CATTLE)

Organisation → Livestock → Register Animal for each individually-tracked
animal. Record tag, sex, birth date, and **fair value at today's market
price** (use the table above as a guide).

Example registrations:

| Tag | Product | Sex | Fair Value | Notes |
|---|---|---|---|---|
| COW-001 | Cattle (Zebu) | FEMALE | KES 75,000 | Breeding cow, 4 years, good condition |
| COW-002 | Cattle (Zebu) | FEMALE | KES 65,000 | Lactating, 3 years |
| BULL-001 | Cattle (Zebu) | MALE | KES 90,000 | Breeding bull, 5 years |
| GOAT-001 | Goat | FEMALE | KES 10,000 | Breeding doe, 2 years |
| GOAT-002 | Goat | MALE | KES 12,000 | Billy, 3 years |
| ... | ... | ... | ... | Continue for the full herd |

After registration, the balance sheet will show the total herd fair value
under Biological Assets — visible from both units.

### Step 6 — Phone and licence (unit: HERD)

**Assets → Buy Asset**: Android Phone, KES 7,000, 3 years, Straight-Line.
**Claims → Expenses → Other**: KES 3,000, "6-month platform licence."

### Step 7 — Insurance and vet provision (unit: CATTLE)

Same as v3, Step 6:
- Insurance policy: KES 300,000 coverage, KES 18,000/year premium, HIGH risk.
- Vet provision: KES 10,000.
- Knowledge note explaining both are charged to CATTLE.

### Step 8 — Daily entries

**Milk sale — HERD, daily:**
Till → Sell: 18–22 litres Milk @ KES 80.
~KES 1,600/day, **~KES 48,000/month**.

**Living costs — HERD, daily:**
Claims → Expenses → Other: KES 2,000/day.
**~KES 60,000/month**.

**Lodging — HERD, 3–4 nights/week:**
Claims → Expenses → Other: KES 500/night.
~15 nights = **~KES 7,500/month**.

**Phone/data — HERD, weekly:**
Claims → Expenses → Utilities: KES 350/week.
**~KES 1,400/month**.

### Step 9 — Periodic cattle/goat sales (unit: CATTLE)

**Cattle sale** (~every 10 days):
Till → Sell: Beef, 120 kg @ KES 350 = KES 42,000.
Then remove the animal from the register: Organisation → Livestock →
Record Loss (reason: "Sold to butcher [name]").

**Goat sale** (~every 5 days):
Till → Sell: Goat Meat, 70 kg @ KES 260 = KES 18,200.
Then remove the goat from the register.

**Transfer to HERD** as needed:
Money → Funds → Transfer, CATTLE → HERD, enough to cover the HERD shortfall.

### Step 10 — Grazing fees (unit: CATTLE)

Claims → Expenses → Other: KES 5,000/month.
Note: "Grazing access fee — [rancher]'s land, [head count] animals."

### Step 11 — Livestock events (unit: CATTLE)

**Birth**: Organisation → Livestock → Record Birth. Fair value the newborn
at today's market price (e.g. KES 20,000 for a healthy calf). This is
genuine IAS 41 income — new wealth appeared with no cash paid.

**Death/disease**: Record Loss, type DEATH_OR_SPOILAGE.
**Theft**: Record Loss, type THEFT (flags HIGH risk, separate P&L line).
**Insurance claim**: POST /api/insurance-policy/:id/claim if covered.

### Step 12 — Monthly review and period close

1. Post depreciation on the phone (KES 194/month).
2. Review the Risk Position panel.
3. Run `GET /api/periods/:id/checklist`.
4. Close the period.

---

## Revised sanity-check totals

### HERD — monthly (what the brothers see as their "pay")

| Item | Amount |
|---|---|
| Milk sales (20L × 80 × 30) | +48,000 |
| Living costs (2,000 × 30) | −60,000 |
| Lodging (~15 nights × 500) | −7,500 |
| Phone/data (350 × 4) | −1,400 |
| Phone depreciation | −194 |
| **HERD net (monthly)** | **−21,094** |

The brothers can see this clearly without understanding accounting:
"The milk makes 48,000 but we spend about 69,000 to live. We're short
about 21,000 every month."

### CATTLE — monthly (the herd's economics)

| Item | Amount |
|---|---|
| Cattle sales (3 × 42,000) | +126,000 |
| Goat sales (6 × 18,200) | +109,200 |
| **Gross sales** | **+235,200** |
| Grazing fees | −5,000 |
| Insurance premium (18,000 ÷ 12) | −1,500 |
| Vet provision (10,000 ÷ 3) | −3,333 |
| **CATTLE operating costs** | **−9,833** |
| **CATTLE net before asset write-off** | **+225,367** |
| Fair value write-off on sold animals (est.) | −200,000 |
| **CATTLE true net** | **~+25,367** |

Note: the fair value write-off is genuine. Selling 3 cattle (fair value
~KES 75,000 each = KES 225,000) and 6 goats (fair value ~KES 10,000 each
= KES 60,000) for KES 235,200 in meat proceeds means the brothers are
converting KES 285,000 of walking assets into KES 235,200 of cash — a real
economic loss of ~KES 50,000 per month on the asset conversion alone. This
is hidden if you only look at cash flow.

### Combined — the accountant's view

| Line | Amount |
|---|---|
| HERD net | −21,094 |
| CATTLE net (after write-offs) | +25,367 |
| **Combined net** | **~+4,273** |
| Transfer from CATTLE to HERD (to cover shortfall) | ~22,000 |
| **Each brother's share** | |
| Cash available after costs | ~235,200 − 9,833 − 69,094 = ~156,273 |
| Divided equally | **~78,000 each** |
| Less: sent home to family (~KES 50,000 each) | −50,000 |
| **Retained per brother** | **~28,000** |

But the accountant will point out: "You made KES 78,000 each in cash, but
your herd lost roughly KES 50,000 in fair value from the animals you sold.
Your real profit per brother is closer to **KES 28,000–39,000 depending on
whether any calves were born this month.** Every birth adds KES 15,000–
25,000 back to the balance sheet."

This is the conversation a bank officer needs to hear: the brothers are
profitable, but their profitability depends on the herd replacing itself
faster than they liquidate it.

---

## What each view shows — designed for three audiences

### The brothers (Manager / Cashier view)

They see the HERD P&L: milk sales, living costs, the gap. They see CATTLE
sales totals. They do not need to understand depreciation, fair value write-
offs, or equity. The numbers they care about: "how much did we make this
month, how much can we send home, how much is left."

### The accountant

Sees the combined Journal, Trial Balance, Balance Sheet (with the herd's
full fair value under Biological Assets), the asset write-offs on every
sale, the insurance coverage ratio, the provision drawdown, and the period-
end checklist results. Can explain to the brothers why their cash profit
is not the same as their economic profit.

### The bank officer

Sees the Balance Sheet showing KES 1,000,000+ in biological assets, the
Cash Flow statement showing positive operating cash flow, the Risk Position
showing active insurance, and the succession plan (when recorded). Can
assess the loan application against real collateral rather than just
monthly sales figures.

---

## Biological asset lifecycle — what the system now tracks

| Stage | Event | Accounting |
|---|---|---|
| Birth/planting | `recordBirth` / `bulkPlanting` | DR Biological Assets CR Gain (IAS 41) |
| Growth | `recordMonthlyReview` | Fair value updated, no Journal entry |
| Adulthood | Fair value at market | Reflected on balance sheet |
| Sale | Till → Sell + Record Loss | Revenue recognised + asset removed |
| Death/theft | `recordAnimalLoss` | DR Loss CR Biological Assets |
| Harvest (crops) | `recordHarvest` | DR Inventory CR Biological Assets |

Value can move in both directions at any stage:
- **Appreciation**: a calf grows into a breeding cow — fair value rises from
  KES 20,000 to KES 75,000 over 2 years, captured through monthly reviews.
- **Depreciation**: meat spoils if not sold quickly, grain loses value in
  storage during surplus season. This is tracked through Resources quality
  and fair value updates.
- **Processing gain**: dry grain sold out of season at a premium, aged meat
  sold at a higher price. Captured through the sale price exceeding the
  recorded fair value.

---

## What this plan cannot yet do

- **Formal payroll**: if the brothers hire a permanent herder, the system
  records it as an expense, not a payroll with PAYE/NHIF/NSSF.
- **Inter-unit P&L consolidation**: the accountant must manually combine
  the two unit P&Ls. An automated consolidated report is not yet built.
- **Seasonal fair value restatement**: the system tracks fair value per
  animal but does not automatically revalue the whole herd at period-end.
  Each animal must be reviewed individually via `recordMonthlyReview`.
