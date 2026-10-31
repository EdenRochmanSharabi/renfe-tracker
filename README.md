# renfe-tracker

Public record of Spanish rail traffic (Renfe live feeds, Cercanias, Basque and Catalan open feeds) collected every minute to every five minutes into the `data` branch, to study how trains behave around accidents. Layout, sources and licences: see the README of the `data` branch.

## Gallery

Charts are generated from the `data` branch and follow the light and dark theme.

### Long-distance trains trace the high-speed corridors

<sub>676,652 train positions, 5-minute samples, 2026-09-19 to 2026-10-31. Source: Renfe GPS feed; lines: OSM high-speed</sub>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/EdenRochmanSharabi/renfe-tracker/gallery/img/map1-density-dark.png?v=25a7de6f">
  <img alt="Long-distance trains trace the high-speed corridors" src="https://raw.githubusercontent.com/EdenRochmanSharabi/renfe-tracker/gallery/img/map1-density-light.png?v=25a7de6f" width="100%">
</picture>

### Weekdays peak at 177 trains in service at 18:00; weekends reach 162

<sub>Mean trains in service per 5-min snapshot, Europe/Madrid hours. Source: Renfe live feed via renfe-tracker stats, 2026-09-20 to 2026-10-31</sub>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/EdenRochmanSharabi/renfe-tracker/gallery/img/daily-rhythm-dark.png?v=713fbf40">
  <img alt="Weekdays peak at 177 trains in service at 18:00; weekends reach 162" src="https://raw.githubusercontent.com/EdenRochmanSharabi/renfe-tracker/gallery/img/daily-rhythm-light.png?v=713fbf40" width="100%">
</picture>

### Typical delay is 5 min, but the slowest tenth runs 64+ min late at 23:00

<sub>Delay of positioned trains, GPS samples every 5 min (n=673,342), 05:00-23:59 Europe/Madrid. Source: renfe-tracker gps, 2026-09-19 to 2026-10-31</sub>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/EdenRochmanSharabi/renfe-tracker/gallery/img/delay-by-hour-dark.png?v=943e8da9">
  <img alt="Typical delay is 5 min, but the slowest tenth runs 64+ min late at 23:00" src="https://raw.githubusercontent.com/EdenRochmanSharabi/renfe-tracker/gallery/img/delay-by-hour-light.png?v=943e8da9" width="100%">
</picture>

### Cercanias: 28% of positions are 5+ min late, led by Madrid and Barcelona

<sub>24,570 vehicle positions from 92 captures, 2026-10-31, coloured by delay (min). Grey: OSM rail network</sub>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/EdenRochmanSharabi/renfe-tracker/gallery/img/map2-cercanias-dark.png?v=00fefa29">
  <img alt="Cercanias: 28% of positions are 5+ min late, led by Madrid and Barcelona" src="https://raw.githubusercontent.com/EdenRochmanSharabi/renfe-tracker/gallery/img/map2-cercanias-light.png?v=00fefa29" width="100%">
</picture>

### Madrid Cercanias trains ran 6.9 min late on average, the most of 4 nuclei

<sub>Mean delay of observed vehicles, 5-min captures, 92 captures, 2026-10-31. Source: Renfe GTFS-RT</sub>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/EdenRochmanSharabi/renfe-tracker/gallery/img/cercanias-by-nucleus-dark.png?v=4bfa85bb">
  <img alt="Madrid Cercanias trains ran 6.9 min late on average, the most of 4 nuclei" src="https://raw.githubusercontent.com/EdenRochmanSharabi/renfe-tracker/gallery/img/cercanias-by-nucleus-light.png?v=4bfa85bb" width="100%">
</picture>

### 28 Oct 2026: long-distance traffic around Urda, 06:00 to 10:00 UTC

<sub>Long-distance train positions, 5-minute samples (no per-minute data for 28 Oct). Collision about 07:54 UTC. Source: Renfe GPS feed; lines: OSM high-speed</sub>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/EdenRochmanSharabi/renfe-tracker/gallery/img/map3-urda-dark.png?v=9478253a">
  <img alt="28 Oct 2026: long-distance traffic around Urda, 06:00 to 10:00 UTC" src="https://raw.githubusercontent.com/EdenRochmanSharabi/renfe-tracker/gallery/img/map3-urda-light.png?v=9478253a" width="100%">
</picture>

### After the Urda collision the index in the cell reached 4.4, above the baseline p99 for that hour

<sub>Health index, cell 39.25-39.50N / 4.00-3.75W, hourly, UTC, 28 Oct 2026; baseline = 41 normal days (8-17 scored days per hour)</sub>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/EdenRochmanSharabi/renfe-tracker/gallery/img/safety3-health-urda-dark.png?v=fc4f07b3">
  <img alt="After the Urda collision the index in the cell reached 4.4, above the baseline p99 for that hour" src="https://raw.githubusercontent.com/EdenRochmanSharabi/renfe-tracker/gallery/img/safety3-health-urda-light.png?v=fc4f07b3" width="100%">
</picture>

<sub>One labelled event, no validated predictive claim: the index is a descriptive anomaly score, not tested as a warning. No score for hour 07 (too few captures before 07:50) and hour 10; hours 8-9 are after the collision. Baseline lines are drawn straight across hours without baseline. Cell = the highest-scoring cell of the Urda zone; the exact collision coordinates are not in the dataset.</sub>

### Significant rail accidents per million train-km fell from 0.38 in 2006 to 0.27 in 2024

<sub>Spain, Eurostat tran_sf_railac / tran_sf_railvi / rail_tf_trainmv, 2006-2024</sub>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/EdenRochmanSharabi/renfe-tracker/gallery/img/safety1-accidents-dark.png?v=7c0a24b0">
  <img alt="Significant rail accidents per million train-km fell from 0.38 in 2006 to 0.27 in 2024" src="https://raw.githubusercontent.com/EdenRochmanSharabi/renfe-tracker/gallery/img/safety1-accidents-light.png?v=7c0a24b0" width="100%">
</picture>

<sub>Significant accident (ERA/Eurostat): at least one moving rail vehicle, with a death, serious injury or damage of EUR 150k+ or serious traffic disruption. Victims are people killed or seriously injured in such accidents (suicides excluded). Rates divide by total train-km (freight + passenger).</sub>

### Rail deaths per million train-km: 0.08 in 2024 (18 killed, 3 seriously injured)

<sub>Spain, Eurostat tran_sf_railac / tran_sf_railvi / rail_tf_trainmv, 2006-2024</sub>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/EdenRochmanSharabi/renfe-tracker/gallery/img/safety1b-victims-dark.png?v=81c9e2b7">
  <img alt="Rail deaths per million train-km: 0.08 in 2024 (18 killed, 3 seriously injured)" src="https://raw.githubusercontent.com/EdenRochmanSharabi/renfe-tracker/gallery/img/safety1b-victims-light.png?v=81c9e2b7" width="100%">
</picture>

<sub>Significant accident (ERA/Eurostat): at least one moving rail vehicle, with a death, serious injury or damage of EUR 150k+ or serious traffic disruption. Victims are people killed or seriously injured in such accidents (suicides excluded). Rates divide by total train-km (freight + passenger). The 2013 peak is the Angrois derailment (Eurostat: 105 killed). Series ends 2024: Adamuz and Urda (2026) are not in it.</sub>

### Spain: 1785 people died on the roads in 2024, 18 in rail accidents

<sub>People killed per year, 2006-2024: road 4104 to 1785, rail 56 to 18; road/rail ratio 99x in 2024 (73x in 2006). Separate y scales.</sub>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/EdenRochmanSharabi/renfe-tracker/gallery/img/rail-vs-road-deaths-dark.png?v=3047b0d3">
  <img alt="Spain: 1785 people died on the roads in 2024, 18 in rail accidents" src="https://raw.githubusercontent.com/EdenRochmanSharabi/renfe-tracker/gallery/img/rail-vs-road-deaths-light.png?v=3047b0d3" width="100%">
</picture>

<sub>Road: persons killed within 30 days of an injury accident, all road users (Eurostat tran_sf_roadus, DG MOVE CARE; Spain's own 24-hour count is lower). Rail: persons killed in significant accidents on the rail network (tran_sf_railvi), suicides excluded, including level-crossing users, trespassers and staff. The two panels have different y axes (rail is far smaller); compare the shape over time, not the heights. Definitions differ: counts are not like for like.</sub>

### Per passenger-km, road was 9.6 times the rail death rate in 2024

<sub>Spain 2006-2024: road 10.4 to 4.5, rail 2.59 to 0.47 killed per billion passenger-km (log scale); rail peaks in 2013 (Angrois)</sub>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/EdenRochmanSharabi/renfe-tracker/gallery/img/rail-vs-road-risk-dark.png?v=d75581bc">
  <img alt="Per passenger-km, road was 9.6 times the rail death rate in 2024" src="https://raw.githubusercontent.com/EdenRochmanSharabi/renfe-tracker/gallery/img/rail-vs-road-risk-light.png?v=d75581bc" width="100%">
</picture>

<sub>Road: persons killed within 30 days of an injury accident, all road users (Eurostat tran_sf_roadus, DG MOVE CARE; Spain's own 24-hour count is lower). Rail: persons killed in significant accidents on the rail network (tran_sf_railvi), suicides excluded, including level-crossing users, trespassers and staff. Denominator: rail passenger-km (rail_pa_total); road = cars and buses, derived as rail passenger-km x (car + bus share) / rail share (tran_hv_psmod, rounded to 0.1 point). Motorcycles, bicycles and walking are not in the denominator, though their deaths are in the road numerator (overstates road risk). Rail deaths include trespassers and level-crossing users, not only passengers (overstates rail risk). Indicative only.</sub>

### Spain 2026 to 30 Sep: 816 road deaths (DGT, 24 h, interurban) and 114 in the two big rail accidents

<sub>Road: DGT provisional deaths 1 Jan to 30 Sep, 816 against 866 in 2025 (published 2 Oct 2026). Rail: Adamuz 46 and Urda 68, press figures to 28 Oct. Separate y scales.</sub>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/EdenRochmanSharabi/renfe-tracker/gallery/img/2026-rail-vs-road-dark.png?v=450d9101">
  <img alt="Spain 2026 to 30 Sep: 816 road deaths (DGT, 24 h, interurban) and 114 in the two big rail accidents" src="https://raw.githubusercontent.com/EdenRochmanSharabi/renfe-tracker/gallery/img/2026-rail-vs-road-light.png?v=450d9101" width="100%">
</picture>

<sub>Road counts deaths within 24 h on interurban roads only (DGT, provisional); Eurostat's 30-day all-roads figures are higher, so the two are not comparable. 2025 is derived from the DGT's stated difference. Rail bars are press figures for two accidents (Urda still provisional, earlier reports said 64); they exclude other 2026 rail deaths not yet published (level crossings, people hit by trains). Road and rail counts are not like for like, and the road period ends 30 Sep.</sub>

### Urda 2026 is the second deadliest rail accident in the seed list, after Angrois 2013

<sub>Spain, 33 listed accidents since 2007 (Wikidata + Wikipedia seed, incomplete); hollow dots = 0 deaths</sub>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/EdenRochmanSharabi/renfe-tracker/gallery/img/safety2-seed-timeline-dark.png?v=905aafee">
  <img alt="Urda 2026 is the second deadliest rail accident in the seed list, after Angrois 2013" src="https://raw.githubusercontent.com/EdenRochmanSharabi/renfe-tracker/gallery/img/safety2-seed-timeline-light.png?v=905aafee" width="100%">
</picture>

<sub>Casualty figures are UNVERIFIED and differ between sources; Urda (28 Oct 2026) is plotted as 74 (seed value); press counts differ and were provisional (68 on 28 Oct per the regional government). The list is biased to media-covered events and is not a census (Eurostat counts ~50-100 significant accidents per year).</sub>
