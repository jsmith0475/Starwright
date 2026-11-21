# Vegetation textures

These files are made by `tools/flora_assets.py` from public-domain scans published by
[ambientCG](https://ambientcg.com) (Lennart Demes) under
[CC0 1.0 Universal](https://creativecommons.org/publicdomain/zero/1.0/). CC0 places the scans in the
public domain: they may be copied, changed and shipped without permission or credit. The credit here
is given by choice.

| File | Made from |
| --- | --- |
| `leaves.webp` (cut-out leaves and boughs) | Leaf Set 016 (oak), Leaf Set 010 (maple), Leaf Set 014 (birch), Leaf Set 022 (shrub), Leaf Set 019 (conifer boughs) |
| `bark_furrowed.jpg`, `bark_furrowed_n.jpg` | Bark 001 |
| `bark_scaly.jpg`, `bark_scaly_n.jpg` | Bark 004 |
| `bark_fir.jpg`, `bark_fir_n.jpg` | Bark 014 |

Each asset's page is `https://ambientcg.com/a/<AssetId>`, for example
<https://ambientcg.com/a/LeafSet016>.

The game arranges the single leaves into sprays when it starts (`js/render/floratex.js`). If these
files are missing, the trees are painted in code instead, so the game still runs.
