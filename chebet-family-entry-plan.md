# Chebet Family Enterprises — Farm-to-Market Entry Plan

A working instruction sequence for Grace Chebet (the farm) and her
daughter-in-law (the market stall), selling vegetables, fruit, eggs,
and spices from a family farm in Naivasha to a grocer stall at the
local market.

---

## The honest economics, stated upfront

This is a **vertically integrated** family enterprise: the farm grows
produce, the market stall sells it. The produce transfers from farm to
stall at cost (no internal markup — it is the same family, the same
business). The stall's margin is the difference between the growing cost
and the market price. The farm's economics are: seasonal planting costs
up front, months of growing with no income, then a harvest that fills
the stall for weeks.

**FARM unit** — Grace's domain. Planting, growing, harvest, livestock
(layers for eggs, dairy cow for milk). Costs: seeds, fertiliser,
seasonal labour during planting, extra security during harvest (theft
is a real risk at harvest time in Naivasha), vet and feed for the cow
and layers.

**SHOP unit** — the daughter-in-law's domain. The market grocer stall
where produce is sold retail: sukuma wiki, cabbage, bananas, oranges,
rosemary, parsley, garlic, eggs (when available), milk. Also buys some
items wholesale from other farms when the Chebet farm's own harvest
doesn't cover demand (oranges, bananas, garlic — items the farm doesn't
grow year-round).

The business makes money when the stall's retail margin exceeds the
farm's growing costs. Seasonality is the real challenge: planting months
have heavy costs (labour, seeds, fertiliser) with no harvest income; 
harvest months have almost no growing costs but need security labour.
Between harvests the stall buys wholesale to stay open.

---

## Family roles

| Person | Unit | Role | Access | Notes |
|---|---|---|---|---|
| Daniel Chebet | Both | Owner | OWNER_FULL | Provides capital, makes major decisions, is away frequently |
| Grace Chebet | FARM | Co-owner, farm manager | MANAGER | Day-to-day farm operations, decides what to plant |
| Daughter-in-law | SHOP | Stall manager, 50/50 profit share | MANAGER | Runs the market stall, supervises employees, operational successor |
| Niece | Both | Accountant/advisor | ACCOUNTANT | Reviews the books, prepares figures for the bank |
| Grandson | Viewer | Future successor | VIEWER | Learning the business, no operational role yet |
| Son | — | Estranged | EXCLUDED | No operational involvement, no succession rights |

The succession plan: Grace and Daniel will hand the **entire enterprise**
to the daughter-in-law. She already operates both units in practice. The
grandson will eventually inherit but is not yet ready.

---

## Products — what the farm grows vs what the stall sells

### Farm-grown products (FARM unit, transferred to SHOP at cost)

| Product | Category | Season | Farm cost (est.) | Stall price |
|---|---|---|---|---|
| Sukuma Wiki (bunch) | Vegetable | Year-round (irrigated) | KES 10 | KES 20 |
| Cabbage (head) | Vegetable | Main season (Mar–Jul) | KES 25 | KES 50 |
| Rosemary (bunch) | Spice/Herb | Year-round (perennial) | KES 5 | KES 20 |
| Parsley (bunch) | Spice/Herb | Year-round (irrigated) | KES 8 | KES 15 |
| Eggs (each) | Poultry | When available (layers) | KES 10 | KES 15 |
| Fresh Milk (1L) | Dairy | Daily (1 cow) | KES 55 | KES 80 |

### Wholesale-bought products (SHOP unit, bought from other farms)

| Product | Buy price | Sell price | Notes |
|---|---|---|---|
| Bananas (hand) | KES 60 | KES 100 | Bought from Kisii/Meru farmers at Naivasha market |
| Oranges (each) | KES 10 | KES 20 | Seasonal from coastal farms |
| Garlic (bulb) | KES 30 | KES 50 | Imported or from Meru, availability varies |

---

## Step 1 — Business setup

1. Sign up: "Chebet Family Enterprises", Industry = Agriculture, Kenya, KES.
2. Business Units: `FARM` and `SHOP`.

### Step 2 — Open backdated trading days

Settings → Periods. Open each day in your two-month window, date order.

### Step 3 — Opening capital (unit: FARM)

Money → Funds → Owner Capital Injection, Day 1:

| Amount | Account | Note |
|---|---|---|
| KES 30,000 | Bank | "Opening savings — farm operations" |
| KES 10,000 | Mobile Money | "M-Pesa float — paying casual workers, buying seeds" |
| KES 5,000 | Cash / Till | "Petty cash — market transport, small purchases" |

Total: **KES 45,000** into FARM.

No inter-unit transfer at setup. The stall starts earning from Day 1
(selling whatever produce is ready). Revenue builds up in SHOP naturally.

---

## Step 4 — Products

**Unit: FARM** — Products page:

| Product | Type | Price | Cost |
|---|---|---|---|
| Sukuma Wiki (bunch) | Goods | KES 20 | KES 10 |
| Cabbage (head) | Goods | KES 50 | KES 25 |
| Rosemary (bunch) | Goods | KES 20 | KES 5 |
| Parsley (bunch) | Goods | KES 15 | KES 8 |
| Eggs (each) | Goods | KES 15 | KES 10 |
| Fresh Milk (1L) | Goods | KES 80 | KES 55 |

Also create under FARM — for the biological asset register:

| Product | Type | Notes |
|---|---|---|
| Layer Chicken | Goods | For tracking individual layers in the register |
| Dairy Cow | Goods | The single cow supplying milk |

**Unit: SHOP** — Products page:

| Product | Type | Price | Cost |
|---|---|---|---|
| Bananas (hand) | Goods | KES 100 | KES 60 |
| Oranges (each) | Goods | KES 20 | KES 10 |
| Garlic (bulb) | Goods | KES 50 | KES 30 |

The farm-grown products (sukuma, cabbage, herbs, eggs, milk) also need to
exist in SHOP's product list at the same prices — they're the same products,
just sold from a different unit. When the stall sells sukuma that came from
the farm, the sale posts against SHOP's copy of the product.

---

## Step 5 — Register livestock (unit: FARM)

### The dairy cow

Organisation → Livestock → Register Animal:
- Tag: COW-001
- Product: Dairy Cow
- Sex: FEMALE
- Fair value: KES 65,000 (market value for a lactating Friesian cross)
- Condition: GOOD

### The layers

Register each individually if the flock is small (under 20), or use
**bulk registration** for a larger flock:

For individual layers:
- Tags: HEN-001 through HEN-012 (or however many)
- Product: Layer Chicken
- Sex: FEMALE
- Fair value: KES 800–1,200 per bird (market value for a laying hen)

For a larger flock:
`POST /api/livestock/bulk-planting` with:
- productId: Layer Chicken
- fieldId: "FLOCK-A"
- plotCount: 30 (number of birds)
- fairValuePerPlot: 1000

Note: `bulkPlanting` works for any batch of biological assets that share
metadata — it's not limited to crops.

---

## Step 6 — Planting the farm (unit: FARM)

### Sukuma wiki and herbs (year-round)

Sukuma wiki grows in 6-week cycles under irrigation. Register a planting
via bulk planting:

`POST /api/livestock/bulk-planting`:
- productId: Sukuma Wiki
- fieldId: "SUKUMA-PLOT-A"
- plotCount: 8 (number of beds/rows)
- plantingDate: the actual planting date
- fairValuePerPlot: KES 200 (estimated value of one bed at maturity)
- growthStage: PLANTED

Rosemary and parsley are perennials — register once:
- Organisation → Livestock → Register Animal (category: CROP)
- Tags: ROSEMARY-BED-1, PARSLEY-BED-1
- Fair value: KES 500 per bed (they produce continuously)

### Cabbage (seasonal, main season)

Bulk planting during March–April:
- fieldId: "CABBAGE-FIELD-B"
- plotCount: 20
- fairValuePerPlot: KES 100 (value increases as cabbage matures)

### Seasonal labour during planting (unit: FARM)

`POST /api/seasonal-labour`:
- description: "Planting sukuma wiki — bed preparation and transplanting"
- days: 3
- dailyRate: KES 500
- labourType: FARM_LABOUR
- paymentMethod: CASH

Repeat for each crop and each planting cycle. A typical planting month
might need 3–4 workers for 3–5 days each = **KES 4,500–10,000/month** in
casual labour during planting.

---

## Step 7 — Harvest and transfer to stall

### Harvesting crops (unit: FARM)

When sukuma wiki is ready (6 weeks after planting):
Organisation → Livestock → Record Harvest:
- plantingResourcesId: the planting's Resources_id
- outputProductId: Sukuma Wiki (the sellable product)
- outputQuantity: 40 bunches (from one bed)
- harvestValue: KES 400 (40 × KES 10 cost)

This moves the value from Biological Assets to Inventory on FARM.

### Seasonal labour during harvest — including security

`POST /api/seasonal-labour`:
- description: "Cabbage harvest — cutting and loading"
- days: 4, dailyRate: KES 500, labourType: HARVEST

And separately for security:
- description: "Night security during cabbage harvest"
- days: 7, dailyRate: KES 800, labourType: SECURITY

The security line is deliberately distinct from farm labour on the P&L
so the accountant can see the theft-mitigation cost separately. In
Naivasha, harvest theft is a known, predictable risk — budgeting for
security is not paranoia, it's realistic accounting.

### Transferring produce to the stall

The farm "sells" produce to the stall at **cost** (no markup). This is
an internal transfer, not a real sale — the same family, the same money.

**FARM side**: Till → Sell, 40 bunches Sukuma Wiki @ KES 10 (cost price).
Revenue: KES 400. Posted to FARM.

**SHOP side**: Till → Buy, 40 bunches Sukuma Wiki @ KES 10.
Inventory increases. Posted to SHOP.

The FARM records a "sale" at cost = zero margin. The real margin appears
only when SHOP sells to a customer at KES 20/bunch. This is the honest
accounting: the farm is a cost centre, the stall is the profit centre,
and the transfer price is transparent.

For items the stall **buys wholesale** from other farms (bananas, oranges,
garlic): post directly to SHOP via Till → Buy at the wholesale price.

---

## Step 8 — Daily stall operations (unit: SHOP)

### Morning: receive produce from the farm

Till → Buy at cost price for whatever the daughter-in-law takes to market
that morning. Typical daily basket from the farm:

| Item | Qty | Cost | Total |
|---|---|---|---|
| Sukuma Wiki | 20 bunches | KES 10 | KES 200 |
| Cabbage | 3 heads | KES 25 | KES 75 |
| Rosemary | 5 bunches | KES 5 | KES 25 |
| Parsley | 5 bunches | KES 8 | KES 40 |
| Eggs | 12 | KES 10 | KES 120 |
| Milk | 5 litres | KES 55 | KES 275 |
| **Farm produce total** | | | **KES 735** |

Plus wholesale purchases (when in stock):

| Item | Qty | Cost | Total |
|---|---|---|---|
| Bananas | 5 hands | KES 60 | KES 300 |
| Oranges | 20 | KES 10 | KES 200 |
| Garlic | 5 bulbs | KES 30 | KES 150 |
| **Wholesale total** | | | **KES 650** |

### All day: sell to customers

Till → Sell for each customer, at retail price. Typical daily sales:

| Item | Qty | Price | Revenue |
|---|---|---|---|
| Sukuma Wiki | 18 bunches | KES 20 | KES 360 |
| Cabbage | 3 heads | KES 50 | KES 150 |
| Rosemary | 4 bunches | KES 20 | KES 80 |
| Parsley | 4 bunches | KES 15 | KES 60 |
| Eggs | 10 | KES 15 | KES 150 |
| Milk | 4 litres | KES 80 | KES 320 |
| Bananas | 4 hands | KES 100 | KES 400 |
| Oranges | 15 | KES 20 | KES 300 |
| Garlic | 3 bulbs | KES 50 | KES 150 |
| **Daily stall revenue** | | | **~KES 1,970** |
| **Daily stall cost** | | | **~KES 1,385** |
| **Daily gross margin** | | | **~KES 585** |

Some items don't sell every day — eggs and garlic are "when available."
Vary the quantities for realism. Unsold perishables (sukuma, parsley)
are a real spoilage cost tracked through inventory write-down if they
wilt overnight.

### Daughter-in-law's share

Her arrangement is 50/50 profit share on produce she manages. Her share
is computed monthly: (SHOP net profit) × 50%. This is a management/payroll
event, posted as:

**Claims → Expenses → Salaries** (or Other):
Amount: 50% of SHOP's monthly net
Note: "Daughter-in-law profit share — [month], 50% of KES [net]"

---

## Step 9 — Farm running costs (unit: FARM)

### Seeds and seedlings (seasonal)

Claims → Expenses → Other:
- KES 2,000 — "Sukuma wiki seedlings — 200 seedlings for SUKUMA-PLOT-A"
- KES 3,000 — "Cabbage seedlings — 300 seedlings for CABBAGE-FIELD-B"
- KES 500 — "Parsley seed packet"

### Fertiliser and pesticides

Claims → Expenses → Other:
- KES 1,500/month — "DAP fertiliser — half bag for sukuma and cabbage"
- KES 800/month — "Pesticide spray — cabbage and sukuma"

### Chicken feed and dairy cow feed

Claims → Expenses → Other:
- KES 3,000/month — "Layer mash — 30 birds × KES 100/month feed"
- KES 2,000/month — "Dairy meal — 1 cow, supplementary feeding"

### Vet costs (provision route)

Same as Maasai v4: provision KES 5,000 for routine vet care.
Utilise on actual vet visit.

---

## Step 10 — Spoilage and wastage

Perishable produce that wilts, rots, or is damaged is a real cost. Two
mechanisms:

**Inventory write-down** (SHOP): when sukuma or parsley wilts unsold
overnight, it's a loss. Post via Till → Sell at KES 0 (zero price, full
quantity), which records the COGS write-off without any revenue. Or use
the Record Loss route on the Resources row.

**Spoilage during repackaging** (FARM): if eggs break during transport
or milk sours before reaching the stall, use the spoilage parameter in
`postRepackaging` or record as Expenses → Other.

---

## Sanity-check totals

### SHOP — monthly (the stall)

| Item | Amount |
|---|---|
| Daily sales (~KES 1,970 × 26 market days) | +51,220 |
| Daily cost of goods (~KES 1,385 × 26) | −36,010 |
| **Gross margin** | **+15,210** |
| Daughter-in-law profit share (50%) | −7,605 |
| Stall rent / market fees (if any) | −2,000 |
| Transport farm → market | −1,500 |
| Spoilage (est. 5% of perishables) | −1,800 |
| **SHOP net** | **~+2,305** |

### FARM — monthly

| Item | Amount |
|---|---|
| Internal "sales" to SHOP (at cost) | ~19,000 |
| Less: cost of production | |
| Seeds/seedlings (amortised monthly) | −2,000 |
| Fertiliser + pesticides | −2,300 |
| Chicken feed | −3,000 |
| Dairy cow feed | −2,000 |
| Casual labour (planting months, amortised) | −3,000 |
| Security (harvest months, amortised) | −2,000 |
| Vet provision | −1,500 |
| **FARM net** | **~+3,200** |

### Combined — the accountant's view

| Line | Amount |
|---|---|
| SHOP net | +2,305 |
| FARM net | +3,200 |
| **Combined monthly net** | **~+5,505** |

This is a genuine small-scale family enterprise: modest but positive
margins, heavily dependent on the daughter-in-law's labour (her profit
share is the single largest cost after goods), and vulnerable to
seasonal gaps and spoilage.

The balance sheet tells the other story: the dairy cow (KES 65,000),
the layer flock (KES 30,000), any standing crops (valued through
monthly reviews), and the stall's inventory are real assets. If Daniel
applied for a SACCO loan against these, the accountant can show genuine
collateral.

---

## The succession path

When Daniel and Grace decide to hand over:

`POST /api/succession`:
- outgoingManagementId: Daniel's Management ID
- incomingManagementId: daughter-in-law's Management ID
- reason: "Retirement. The daughter-in-law has managed both the farm
  and the stall for [X] years. Grace continues to advise on planting
  decisions. The grandson will take over when ready."

This:
- Posts the equity transfer (Daniel's capital → daughter-in-law)
- Updates Daniel to RETIRED/VIEWER
- Updates daughter-in-law to CURRENT_OWNER/OWNER_FULL
- Writes a Knowledge entry recording the decision and reasoning

Grace's second succession can happen later when she's ready — a
separate `postSuccession` call for her share. The system supports
sequential handovers.

---

## What each view shows

### The daughter-in-law (SHOP manager)

SHOP P&L: daily sales, cost of goods, her profit share as a line item.
She sees what the stall makes and what she earns. She doesn't need to
see the farm's growing costs — that is Grace's domain.

### Grace (FARM manager)

FARM P&L: growing costs (seeds, fertiliser, labour, feed, vet), the
internal "sales" to SHOP at cost. She sees whether the farm covers its
own costs. She doesn't need to see the stall's retail margin.

### The niece (Accountant)

Combined Journal, Trial Balance, Balance Sheet. The full picture: farm
growing costs + stall margins + livestock assets + the inter-unit
transfer at cost. She prepares the figures Daniel takes to the bank.

### Daniel (Owner)

Sees everything, but what matters to him: the combined net figure, the
balance sheet total (his wealth), and the Knowledge page where the
succession reasoning is recorded for his grandson to read someday.

---

## Biological asset lifecycle — what grows on this farm

| Stage | Crops | Livestock |
|---|---|---|
| **Acquisition** | Buy seeds/seedlings (Expense) → bulk planting (register) | Buy day-old chicks or heifer (Asset Purchase) → register |
| **Growth** | Monthly review: update growth stage, fair value | Monthly review: update condition, egg count |
| **Production** | Harvest → inventory (sukuma, cabbage, herbs) | Daily: collect eggs and milk (sell via SHOP) |
| **Maturity** | Harvest complete; replant (new cycle) | Layers produce ~18 months; cow produces years |
| **End of life** | Crop residue — no value (compost) | Spent layer sold (KES 300–500); cow sold or replaced |
| **Appreciation** | Dry grain stored for off-season premium | Breeding cow's calf is a new asset (recordBirth) |
| **Depreciation** | Wilted produce (spoilage) | Aging layer's production drops (fair value review) |

---

## What this plan cannot yet do

- **Formal payroll** for the daughter-in-law: her profit share is posted
  as an expense, not through a payroll register with PAYE.
- **Automated inter-unit transfer**: the farm-to-stall transfer is two
  manual Till entries (sell from FARM, buy into SHOP). A single "transfer
  produce" feature would reduce this to one step.
- **Spoilage tracking per product**: the platform tracks inventory
  quantities but does not yet flag items nearing expiry automatically.
  Spoilage is posted manually when produce wilts.
- **Seasonal cash flow forecasting**: the accountant can see historical
  patterns but cannot model "if we plant cabbage in March, when does the
  harvest income arrive?" This is a reporting gap, not a posting gap.
