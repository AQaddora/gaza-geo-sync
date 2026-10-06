# Built in Gaza

This library was written in Gaza, for an app that people in Gaza use to find shared rides.

Software made here is shaped by the network it runs on. For most of the last two decades Gaza's
mobile operators have been limited to 2G (GSM with EDGE for data); the World Bank described mobile
internet there as running on EDGE, "similar to fixed narrowband internet access"
([World Bank, 2016](https://documents1.worldbank.org/curated/en/993031473856114803/pdf/104263-REVISED-title-a-little-different-WP-P150798-NOW-OUO-9.pdf), §3.3).
Wi-Fi, where there is any, is often shared by many people through one uplink. Connectivity drops
in and out. A map that refreshes every 30 seconds has to be designed for that, not merely tolerate it.

So the design choices here come from use, not from a benchmark: few bytes, few requests, nothing
that breaks when the connection is gone, and a JSON fallback so no phone is ever left behind.

## Why share it

Developers in Gaza solve problems that many places share — expensive data, weak links, old phones —
and the solutions are worth as much elsewhere. Publishing this as an open, documented, tested
template is a small contribution from Gaza's tech community to everyone building for low-bandwidth
users: transport apps, delivery, humanitarian logistics, field teams, fleets.

If you use it, we would love to hear where. Open a *Field report* issue.

— Ahmed Qaddoura and contributors
