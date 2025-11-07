# Wikipedia Random Walk Explorer

Interactive client-side visualiser that performs a random walk across Wikipedia.

## Getting Started

- Open `index.html` in a modern browser (Chrome, Edge, Safari, Firefox).
- Enter a starting page title (e.g., `Alan Turing`) and click **Start**.
- Pause, resume, or single-step the walk using the sidebar controls.

## How It Works

- Each step fetches a random internal link from the current page using the MediaWiki API.
- Nodes represent visited pages; size grows with revisits while colour darkens (white → red → black) with the number of walk connections separating the page from the start.
- Similarity links connect pages that share overlapping categories (top three matches per new page).
- Walk links grow thicker as the same transition occurs multiple times.

All requests are made directly from the browser; no backend server is required.