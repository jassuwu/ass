# Sound sources

Every file in `public/sfx/` is sliced from a CC0 recording on Freesound.
No attribution is required by the licence; it is recorded here so the
provenance is never in doubt. Slices are peak-normalised to -1 dBFS with
2 ms / 25 ms fades and encoded as mono 44.1 kHz MP3 from the HQ previews.

| bank | source | author | what it is |
|---|---|---|---|
| `crack-*` | [744622](https://freesound.org/s/744622/) | desiderium_audio | bare-skin thigh slaps, eight single hits |
| `leg-*` | [393899](https://freesound.org/s/393899/) | Rodzuz | open hand on leg, Zoom H4n, six loud hits |
| `body-*` | [866001](https://freesound.org/s/866001/) | Gitzen | a slap on the buttock, seven hits with low-end body |
| `pat-*` | [235335](https://freesound.org/s/235335/) | apocbot | gentle skin pats and grabs, five takes |
| `heart-1` | [22440](https://freesound.org/s/22440/) | Lunardrive | one clean heartbeat |
| `rub-1` | [554076](https://freesound.org/s/554076/) | christophe1138 | hand caressing bare skin, six seconds, looped |

Hit times inside the source recordings were found by onset detection and
are listed in the slicing script that produced them (kept out of the repo;
the table above is enough to reproduce with any editor).
