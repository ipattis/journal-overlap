# Journal Overlap Finder

A browser-based research tool for discovering **authorship overlap between two sets of academic journals**, powered by the [OpenAlex](https://openalex.org) open scholarly metadata API.

Given two sets of journals (Set A and Set B), the app finds all authors who have published in **both** sets since 2023, then surfaces insights across five analytical views.

---

## Features

| Tab | What it shows |
|-----|---------------|
| **Authors** | Ranked list of bridging authors with article details, ORCID links, and a word cloud of the top 100 |
| **Journal Pairs** | Which specific A × B journal combinations share the most authors |
| **Institutions** | Which institutions have the most researchers bridging both sets |
| **Topics** | Topic-level overlap across OpenAlex's 4-level hierarchy (Domain → Field → Subfield → Topic), with word clouds at Subfield and Topic granularity |

---

## Running Locally

**Requirements:** Node.js 18+ and npm.

```bash
# 1. Clone the repo
git clone https://github.com/teowaits/journal-overlap.git
cd journal-overlap

# 2. Install dependencies
npm install

# 3. Start the dev server
npm run dev
```

Then open [http://localhost:5173](http://localhost:5173) in your browser.

```bash
# Build for production
npm run build

# Preview the production build
npm run preview
```

No API key is required — OpenAlex is free and open. For sustained heavy usage, you can add a polite header by registering an email at [openalex.org/settings/api](https://openalex.org/settings/api).

---

## How It Works

1. **Journal resolution** — journal names are resolved to OpenAlex Source IDs via the `/sources` search endpoint.
2. **Work fetching** — all articles published in each journal since 2023 are fetched in paginated batches (`/works`), capturing authorship, institution affiliation, and `primary_topic`.
3. **Intersection** — authors present in both Set A and Set B are identified client-side.
4. **Enrichment** — the top N overlapping authors are enriched via the `/authors` endpoint (citation counts, ORCID, last known institution).
5. **Analytics** — journal pairs, institution counts, and topic aggregations are all computed in-memory from the fetched data with no additional API calls.

### Practical limits

| Set size | Estimated run time |
|----------|--------------------|
| 1–3 journals | 10–30 seconds |
| 5–10 journals | 1–3 minutes |
| 20+ journals | 5–10+ minutes |

Large mega-journals (e.g. PLOS ONE, Scientific Reports) have ~15–20k articles per year and will hit the 10k per-journal paging cap.

---

## Data & Acknowledgements

All scholarly metadata is provided by **[OpenAlex](https://openalex.org)** — a fully open, free index of global research output maintained by [OurResearch](https://ourresearch.org). OpenAlex data is released under the [CC0 1.0 Universal](https://creativecommons.org/publicdomain/zero/1.0/) public domain dedication.

> Priem, J., Piwowar, H., & Orr, R. (2022). OpenAlex: A fully-open index of the world's research. *arXiv*. https://doi.org/10.48550/arXiv.2205.01833

---

## Created By

**[teowaits](https://github.com/teowaits)**

This tool was built with the assistance of [Claude Sonnet 4.6](https://www.anthropic.com/claude) by Anthropic, following OpenAlex API best practices:

- Two-step journal resolution (search → ID) rather than filtering by name
- Polite rate limiting with inter-request delays
- `select=` field filtering to minimise response payload
- Year-chunked pagination to stay within the 10k result paging wall
- Client-side intersection and analytics to avoid redundant API calls

---

## License

[MIT](LICENSE)
