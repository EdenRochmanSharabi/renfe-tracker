# renfe-tracker

Public record of Spanish rail traffic (Renfe live feeds, Cercanias, Basque and Catalan open feeds) collected every minute to every five minutes into the `data` branch, to study how trains behave around accidents. Layout, sources and licences: see the README of the `data` branch.

## Gallery

Charts are generated from the `data` branch and follow the light and dark theme.

### Long-distance trains trace the high-speed corridors

<sub>674,982 train positions, 5-minute samples, 2026-09-19 to 2026-10-31. Source: Renfe GPS feed; lines: OSM high-speed</sub>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/EdenRochmanSharabi/renfe-tracker/gallery/img/map1-density-dark.png?v=272217a6">
  <img alt="Long-distance trains trace the high-speed corridors" src="https://raw.githubusercontent.com/EdenRochmanSharabi/renfe-tracker/gallery/img/map1-density-light.png?v=272217a6" width="100%">
</picture>

### Weekdays peak at 177 trains in service at 18:00; weekends reach 162

<sub>Mean trains in service per 5-min snapshot, Europe/Madrid hours. Source: Renfe live feed via renfe-tracker stats, 2026-09-20 to 2026-10-31</sub>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/EdenRochmanSharabi/renfe-tracker/gallery/img/daily-rhythm-dark.png?v=713fbf40">
  <img alt="Weekdays peak at 177 trains in service at 18:00; weekends reach 162" src="https://raw.githubusercontent.com/EdenRochmanSharabi/renfe-tracker/gallery/img/daily-rhythm-light.png?v=713fbf40" width="100%">
</picture>

### Typical delay is 5 min, but the slowest tenth runs 64+ min late at 23:00

<sub>Delay of positioned trains, GPS samples every 5 min (n=671,672), 05:00-23:59 Europe/Madrid. Source: renfe-tracker gps, 2026-09-19 to 2026-10-31</sub>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/EdenRochmanSharabi/renfe-tracker/gallery/img/delay-by-hour-dark.png?v=bf3ce5c0">
  <img alt="Typical delay is 5 min, but the slowest tenth runs 64+ min late at 23:00" src="https://raw.githubusercontent.com/EdenRochmanSharabi/renfe-tracker/gallery/img/delay-by-hour-light.png?v=bf3ce5c0" width="100%">
</picture>

### Cercanias: 28% of positions are 5+ min late, led by Madrid and Barcelona

<sub>20,252 vehicle positions from 76 captures, 2026-10-31, coloured by delay (min). Grey: OSM rail network</sub>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/EdenRochmanSharabi/renfe-tracker/gallery/img/map2-cercanias-dark.png?v=860aebd7">
  <img alt="Cercanias: 28% of positions are 5+ min late, led by Madrid and Barcelona" src="https://raw.githubusercontent.com/EdenRochmanSharabi/renfe-tracker/gallery/img/map2-cercanias-light.png?v=860aebd7" width="100%">
</picture>

### Madrid Cercanias trains ran 6.9 min late on average, the most of 4 nuclei

<sub>Mean delay of observed vehicles, 5-min captures, 76 captures, 2026-10-31. Source: Renfe GTFS-RT</sub>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/EdenRochmanSharabi/renfe-tracker/gallery/img/cercanias-by-nucleus-dark.png?v=0a7c3fe0">
  <img alt="Madrid Cercanias trains ran 6.9 min late on average, the most of 4 nuclei" src="https://raw.githubusercontent.com/EdenRochmanSharabi/renfe-tracker/gallery/img/cercanias-by-nucleus-light.png?v=0a7c3fe0" width="100%">
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

### Urda 2026 is the second deadliest rail accident in the seed list, after Angrois 2013

<sub>Spain, 33 listed accidents since 2007 (Wikidata + Wikipedia seed, incomplete); hollow dots = 0 deaths</sub>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/EdenRochmanSharabi/renfe-tracker/gallery/img/safety2-seed-timeline-dark.png?v=a07bd9ac">
  <img alt="Urda 2026 is the second deadliest rail accident in the seed list, after Angrois 2013" src="https://raw.githubusercontent.com/EdenRochmanSharabi/renfe-tracker/gallery/img/safety2-seed-timeline-light.png?v=a07bd9ac" width="100%">
</picture>

<sub>Casualty figures are UNVERIFIED and differ between sources; Urda (28 Oct 2026) is reported as 69-74 deaths, 74 plotted. The list is biased to media-covered events and is not a census (Eurostat counts ~50-100 significant accidents per year).</sub>
