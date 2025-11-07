(() => {
  const API_BASE = "https://en.wikipedia.org/w/api.php";
  const REST_SUMMARY_BASE = "https://en.wikipedia.org/api/rest_v1/page/summary/";
  const MAX_LOG_ITEMS = 50;
  const SIMILARITY_NEIGHBORS = 3;
  const DEPTH_COLOR_STOPS = [
    { position: 0, rgb: [255, 255, 255] },
    { position: 0.6, rgb: [185, 28, 28] },
    { position: 1, rgb: [0, 0, 0] }
  ];

  const state = {
    nodes: [],
    links: [],
    nodeIndex: new Map(),
    linkIndex: new Map(),
    walkStack: [],
    depths: new Map(),
    adjacency: new Map(),
    seedId: null,
    maxFiniteDepth: 0,
    nodeScale: 1,
    running: false,
    loopPromise: null,
    stepCount: 0,
    currentTitle: null,
    previousTitle: null,
    inFlight: false,
    visitHistory: []
  };

  const controls = {};
  let graph;
  let feedbackTimeoutId = null;
  const audio = {
    context: null
  };

  window.addEventListener("DOMContentLoaded", () => {
    cacheControls();
    graph = new ForceGraph("#graph");
    attachEvents();
    updateUI();
  });

  function cacheControls() {
    controls.form = document.getElementById("start-form");
    controls.startInput = document.getElementById("start-title");
    controls.startBtn = document.getElementById("start-btn");
    controls.pauseBtn = document.getElementById("pause-btn");
    controls.stepBtn = document.getElementById("step-btn");
    controls.resetBtn = document.getElementById("reset-btn");
    controls.stepCount = document.getElementById("step-count");
    controls.uniqueCount = document.getElementById("unique-count");
    controls.currentPage = document.getElementById("current-page");
    controls.maxDistance = document.getElementById("max-distance");
    controls.walkLinkCount = document.getElementById("walk-link-count");
    controls.similarityCount = document.getElementById("similarity-count");
    controls.feedback = document.getElementById("feedback");
    controls.visitLog = document.getElementById("visit-log");
    controls.nodeScale = document.getElementById("node-scale");
    controls.nodeScaleDisplay = document.getElementById("node-scale-display");
  }

  function attachEvents() {
    controls.form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const value = controls.startInput.value.trim();
      if (!value) {
        setFeedback("Enter a starting page title to begin.");
        return;
      }
      await startWalk(value);
    });

    controls.pauseBtn.addEventListener("click", () => {
      if (state.running) {
        pauseWalk();
      } else {
        resumeWalk();
      }
    });

    controls.stepBtn.addEventListener("click", async () => {
      await performStep(true);
    });

    controls.resetBtn.addEventListener("click", () => {
      resetAll();
      setFeedback("Walk reset.", "success");
    });

    controls.nodeScale?.addEventListener("input", (event) => {
      const value = Number.parseFloat(event.target.value);
      if (!Number.isFinite(value) || value <= 0) return;
      state.nodeScale = value;
      updateNodeScaleDisplay();
      if (graph) {
        graph.update(state.nodes, state.links);
      }
    });
  }

  function getAudioContext() {
    if (audio.context) {
      if (audio.context.state === "suspended") {
        audio.context.resume().catch(() => {});
      }
      return audio.context;
    }

    const AudioContextCls = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextCls) {
      return null;
    }

    try {
      audio.context = new AudioContextCls();
      return audio.context;
    } catch (error) {
      console.warn("Audio context unavailable", error);
      return null;
    }
  }

  function playPopSound() {
    const ctx = getAudioContext();
    if (!ctx) return;

    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = "sine";
    osc.frequency.setValueAtTime(320, now);
    osc.frequency.exponentialRampToValueAtTime(160, now + 0.12);

    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.3, now + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.18);

    osc.connect(gain);
    gain.connect(ctx.destination);

    osc.start(now);
    osc.stop(now + 0.2);
    osc.onended = () => {
      osc.disconnect();
      gain.disconnect();
    };
  }

  function playChimeSound() {
    const ctx = getAudioContext();
    if (!ctx) return;

    const now = ctx.currentTime;
    const osc1 = ctx.createOscillator();
    const osc2 = ctx.createOscillator();
    const gain = ctx.createGain();

    osc1.type = "sine";
    osc2.type = "sine";

    osc1.frequency.setValueAtTime(880, now);
    osc1.frequency.exponentialRampToValueAtTime(1320, now + 0.25);

    osc2.frequency.setValueAtTime(660, now);
    osc2.frequency.exponentialRampToValueAtTime(990, now + 0.22);

    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.25, now + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.35);

    osc1.connect(gain);
    osc2.connect(gain);
    gain.connect(ctx.destination);

    osc1.start(now);
    osc2.start(now);
    osc1.stop(now + 0.4);
    osc2.stop(now + 0.4);
    let cleaned = false;
    const finish = () => {
      if (cleaned) return;
      cleaned = true;
      osc1.disconnect();
      osc2.disconnect();
      gain.disconnect();
    };
    osc1.onended = finish;
    osc2.onended = finish;
  }

  async function startWalk(seedInput) {
    try {
      const normalizedSeed = normalizeTitle(seedInput);
      if (!normalizedSeed) {
        setFeedback("Unrecognized title. Please try again.");
        return;
      }

      setFeedback("Preparing random walk...", "success");
      getAudioContext();
      resetAll();
      state.seedId = normalizedSeed;

  await visitPage(normalizedSeed, 0, { isSeed: true });
  state.running = true;
  ensureLoopRunning();
      updateUI();
      setFeedback(`Walking from ${prettifyTitle(normalizedSeed)}.`, "success");
    } catch (error) {
      console.error(error);
      setFeedback(error.message || "Failed to start walk.");
      resetAll();
    }
  }

  function ensureLoopRunning() {
    if (!state.running) return;
    if (!state.loopPromise) {
      state.loopPromise = stepLoop();
    }
  }

  async function stepLoop() {
    try {
      while (state.running) {
        await performStep();
      }
    } finally {
      state.loopPromise = null;
    }
  }

  async function performStep(manual = false) {
    if (state.inFlight) return;
    state.inFlight = true;

    try {
      if (!state.currentTitle) {
        throw new Error("No active page. Start a walk first.");
      }

      const availability = await ensureLinksAvailable();
      if (!availability) {
        setFeedback("No further links available after backtracking. Walk paused.");
        stopRunning();
        return;
      }

      if (availability.backtracked) {
        setFeedback(
          `Backtracked to ${prettifyTitle(availability.fromTitle)}; continuing walk.`,
          "success"
        );
      }

      const nextTitle = pickRandomLink(availability.links, state.previousTitle);
      state.stepCount += 1;
      await visitPage(nextTitle, state.stepCount);

      if (manual) {
        setFeedback(`Stepped to ${prettifyTitle(nextTitle)}.`, "success");
      }
    } catch (error) {
      console.error(error);
      setFeedback(error.message || "Step failed.");
      stopRunning();
    } finally {
      state.inFlight = false;
      updateUI();
    }
  }

  async function ensureLinksAvailable() {
    const avoid = new Set();
    let backtracked = false;

    while (state.currentTitle) {
      const links = await fetchLinks(state.currentTitle);
      const filtered = links.filter((link) => !avoid.has(link));
      if (filtered.length) {
        return {
          links: filtered,
          fromTitle: state.currentTitle,
          backtracked
        };
      }

      avoid.add(state.currentTitle);
      const couldBacktrack = backtrackOne(avoid);
      if (!couldBacktrack) {
        return null;
      }
      backtracked = true;
    }

    return null;
  }

  function backtrackOne(avoidSet) {
    if (state.walkStack.length <= 1) {
      state.walkStack = [];
      state.currentTitle = null;
      state.previousTitle = null;
      updateUI();
      return false;
    }

    const discarded = state.walkStack.pop();
    if (discarded && avoidSet) {
      avoidSet.add(discarded);
    }

    const newCurrent = state.walkStack[state.walkStack.length - 1];
    state.currentTitle = newCurrent;
    state.previousTitle = state.walkStack.length > 1 ? state.walkStack[state.walkStack.length - 2] : null;
    updateUI();
    return true;
  }

  function pauseWalk() {
    if (!state.running) return;
    state.running = false;
    updateUI();
    setFeedback("Walk paused.", "success");
  }

  function resumeWalk() {
    if (state.running || !state.currentTitle) return;
    state.running = true;
    updateUI();
    setFeedback("Walk resumed.", "success");
    ensureLoopRunning();
  }

  function stopRunning() {
    state.running = false;
    updateUI();
  }

  function resetAll() {
    state.running = false;
    state.loopPromise = null;
    state.stepCount = 0;
    state.currentTitle = null;
    state.previousTitle = null;
    state.inFlight = false;
    state.visitHistory = [];
    state.walkStack = [];
    state.depths = new Map();
    state.adjacency = new Map();
    state.seedId = null;
    state.maxFiniteDepth = 0;
    state.nodes.length = 0;
    state.links.length = 0;
    state.nodeIndex.clear();
    state.linkIndex.clear();
    graph.reset();
    renderVisitLog();
    updateUI();
  }

  async function visitPage(title, stepNumber, options = {}) {
    const normalized = normalizeTitle(title);
    const { node, isNew } = await ensureNode(normalized);

    node.visitCount += 1;
    node.lastVisited = new Date();

    const prior = state.currentTitle;
    if (!options.isSeed && prior) {
      upsertWalkLink(prior, node.id);
    }

    if (isNew) {
      updateSimilarityEdges(node);
      playPopSound();
    }

    state.previousTitle = prior;
    state.currentTitle = node.id;
    state.walkStack.push(node.id);

    refreshDepths();

    recordVisit(node, stepNumber);
    graph.update(state.nodes, state.links);
    updateUI();
    return node;
  }

  async function ensureNode(title) {
    const existing = state.nodeIndex.get(title);
    if (existing) {
      if (!state.adjacency.has(existing.id)) {
        state.adjacency.set(existing.id, new Set());
      }
      return { node: existing, isNew: false };
    }

    const [categories, summaryData] = await Promise.all([
      fetchCategories(title),
      fetchSummary(title)
    ]);

    const node = addNode({
      id: title,
      title: prettifyTitle(title),
      url: summaryData?.content_urls?.desktop?.page || `https://en.wikipedia.org/wiki/${encodeURIComponent(title)}`,
      summary: summaryData?.extract || "No summary available.",
      categories,
      categorySet: new Set(categories)
    });

    return { node, isNew: true };
  }

  function addNode(config) {
    const node = {
      id: config.id,
      title: config.title,
      url: config.url,
      summary: config.summary,
      categories: config.categories,
      categorySet: config.categorySet,
      visitCount: 0,
      lastVisited: null,
      depth: Infinity
    };

    if (graph) {
      const point = graph.randomPoint();
      node.x = point.x;
      node.y = point.y;
    }

    state.nodes.push(node);
    state.nodeIndex.set(node.id, node);
    if (!state.adjacency.has(node.id)) {
      state.adjacency.set(node.id, new Set());
    }
    if (state.seedId) {
      refreshDepths();
    }
    return node;
  }

  function upsertWalkLink(sourceId, targetId) {
    const key = linkKey(sourceId, targetId, "walk");
    let link = state.linkIndex.get(key);
    if (!link) {
      link = { source: sourceId, target: targetId, type: "walk", weight: 1 };
      state.links.push(link);
      state.linkIndex.set(key, link);
    } else {
      link.weight += 1;
    }
    addAdjacencyEdge(sourceId, targetId);
  }

  function addAdjacencyEdge(a, b) {
    if (!a || !b || a === b) return;

    if (!state.adjacency.has(a)) {
      state.adjacency.set(a, new Set());
    }
    if (!state.adjacency.has(b)) {
      state.adjacency.set(b, new Set());
    }

    state.adjacency.get(a).add(b);
    state.adjacency.get(b).add(a);
  }

  function updateSimilarityEdges(node) {
    if (!node.categorySet.size) return;

    const candidates = state.nodes
      .filter((other) => other.id !== node.id && other.categorySet.size)
      .map((other) => ({
        node: other,
        similarity: jaccard(node.categorySet, other.categorySet)
      }))
      .filter((entry) => entry.similarity > 0)
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, SIMILARITY_NEIGHBORS);

    for (const entry of candidates) {
      upsertSimilarityLink(node.id, entry.node.id, entry.similarity);
    }
  }

  function upsertSimilarityLink(sourceId, targetId, similarity) {
    const key = linkKey(sourceId, targetId, "similarity");
    const clamped = Math.min(Math.max(similarity, 0), 1);
    let link = state.linkIndex.get(key);
    if (!link) {
      link = { source: sourceId, target: targetId, type: "similarity", weight: clamped };
      state.links.push(link);
      state.linkIndex.set(key, link);
      playChimeSound();
    } else {
      link.weight = Math.max(link.weight, clamped);
    }
    addAdjacencyEdge(sourceId, targetId);
  }

  function refreshDepths() {
    if (!state.seedId || !state.nodes.length) {
      return;
    }

    const depths = new Map();
    const queue = [];

    depths.set(state.seedId, 0);
    queue.push(state.seedId);

    while (queue.length) {
      const current = queue.shift();
      const currentDepth = depths.get(current) ?? 0;
      const neighbors = state.adjacency.get(current);
      if (!neighbors) continue;

      neighbors.forEach((neighbor) => {
        if (!depths.has(neighbor)) {
          depths.set(neighbor, currentDepth + 1);
          queue.push(neighbor);
        }
      });
    }

    state.nodes.forEach((node) => {
      const depth = depths.has(node.id) ? depths.get(node.id) : Infinity;
      node.depth = depth;
      if (!depths.has(node.id)) {
        depths.set(node.id, depth);
      }
    });

    state.depths = depths;
    state.maxFiniteDepth = Array.from(depths.values()).reduce((max, value) => {
      if (!Number.isFinite(value)) return max;
      return value > max ? value : max;
    }, 0);
  }

  function nodeColor(node) {
    if (state.seedId && node?.id === state.seedId) {
      return "#00ff66";
    }
    const depth = Number.isFinite(node?.depth) ? node.depth : 0;
    return depthToColor(depth);
  }

  function depthToColor(depth) {
    if (!DEPTH_COLOR_STOPS.length) {
      return "#ffffff";
    }

    if (!Number.isFinite(depth)) {
      const lastStop = DEPTH_COLOR_STOPS[DEPTH_COLOR_STOPS.length - 1];
      return rgbToHex(...lastStop.rgb);
    }

    const denominator = Math.max(state.maxFiniteDepth, 1);
    if (denominator <= 0) {
      return rgbToHex(...DEPTH_COLOR_STOPS[0].rgb);
    }

    const ratio = Math.min(1, Math.max(0, depth / denominator));
    return interpolateStopColor(ratio);
  }

  function interpolateStopColor(t) {
    if (t <= DEPTH_COLOR_STOPS[0].position) {
      return rgbToHex(...DEPTH_COLOR_STOPS[0].rgb);
    }

    const lastStop = DEPTH_COLOR_STOPS[DEPTH_COLOR_STOPS.length - 1];
    if (t >= lastStop.position) {
      return rgbToHex(...lastStop.rgb);
    }

    let left = DEPTH_COLOR_STOPS[0];
    let right = lastStop;
    for (let i = 0; i < DEPTH_COLOR_STOPS.length - 1; i += 1) {
      const current = DEPTH_COLOR_STOPS[i];
      const next = DEPTH_COLOR_STOPS[i + 1];
      if (t >= current.position && t <= next.position) {
        left = current;
        right = next;
        break;
      }
    }

    const span = right.position - left.position || 1;
    const localT = (t - left.position) / span;
    const r = Math.round(left.rgb[0] + (right.rgb[0] - left.rgb[0]) * localT);
    const g = Math.round(left.rgb[1] + (right.rgb[1] - left.rgb[1]) * localT);
    const b = Math.round(left.rgb[2] + (right.rgb[2] - left.rgb[2]) * localT);
    return rgbToHex(r, g, b);
  }

  function rgbToHex(r, g, b) {
    const toHex = (component) => {
      const clamped = Math.max(0, Math.min(255, Math.round(component)));
      return clamped.toString(16).padStart(2, "0");
    };
    return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
  }

  function recordVisit(node, stepNumber) {
    const entry = {
      id: node.id,
      title: node.title,
      url: node.url,
      summary: node.summary,
      visits: node.visitCount,
      step: stepNumber
    };

    state.visitHistory.unshift(entry);
    if (state.visitHistory.length > MAX_LOG_ITEMS) {
      state.visitHistory.length = MAX_LOG_ITEMS;
    }

    renderVisitLog();
  }

  function renderVisitLog() {
    const list = controls.visitLog;
    if (!list) return;
    list.innerHTML = "";

    state.visitHistory.forEach((entry) => {
      const li = document.createElement("li");
      const anchor = document.createElement("a");
      anchor.href = entry.url;
      anchor.target = "_blank";
      anchor.rel = "noopener noreferrer";
      anchor.textContent = entry.title;
      li.appendChild(anchor);

      const meta = document.createElement("span");
      meta.className = "visit-meta";
      meta.textContent = `step ${entry.step} • visits ${entry.visits}`;
      li.appendChild(meta);

      list.appendChild(li);
    });
  }

  function updateUI() {
    controls.stepCount.textContent = String(state.stepCount);
    controls.uniqueCount.textContent = String(state.nodes.length);
    const currentNode = state.currentTitle ? state.nodeIndex.get(state.currentTitle) : null;
    controls.currentPage.textContent = currentNode ? currentNode.title : "–";
    controls.maxDistance.textContent = String(state.maxFiniteDepth ?? 0);

    let walkLinks = 0;
    let similarityLinks = 0;
    for (const link of state.links) {
      if (link.type === "walk") {
        walkLinks += 1;
      } else if (link.type === "similarity") {
        similarityLinks += 1;
      }
    }
    controls.walkLinkCount.textContent = String(walkLinks);
    controls.similarityCount.textContent = String(similarityLinks);

    controls.pauseBtn.disabled = !state.currentTitle;
    controls.resetBtn.disabled = !state.currentTitle && !state.nodes.length;
    controls.stepBtn.disabled = state.running || !state.currentTitle;
    controls.pauseBtn.textContent = state.running ? "Pause" : "Resume";
    controls.startBtn.textContent = state.currentTitle ? "Restart" : "Start";

    updateNodeScaleDisplay();
  }

  function updateNodeScaleDisplay() {
    if (!controls.nodeScaleDisplay || !controls.nodeScale) return;
    controls.nodeScale.value = String(state.nodeScale);
    const display = state.nodeScale % 1 === 0 ? state.nodeScale.toFixed(0) : state.nodeScale.toFixed(1);
    controls.nodeScaleDisplay.textContent = `${display.replace(/\.0$/, "")}×`;
  }

  function setFeedback(message, tone) {
    if (!controls.feedback) return;
    clearTimeout(feedbackTimeoutId);
    controls.feedback.textContent = message || "";
    controls.feedback.classList.toggle("success", tone === "success");

    if (message) {
      feedbackTimeoutId = setTimeout(() => {
        controls.feedback.textContent = "";
        controls.feedback.classList.remove("success");
      }, 6000);
    }
  }

  function pickRandomLink(links, avoidId) {
    if (!links.length) return null;
    if (links.length === 1) return links[0];

    let candidate = links[Math.floor(Math.random() * links.length)];
    if (avoidId && candidate === avoidId) {
      const filtered = links.filter((item) => item !== avoidId);
      if (filtered.length) {
        candidate = filtered[Math.floor(Math.random() * filtered.length)];
      }
    }
    return candidate;
  }

  function linkKey(source, target, type) {
    const a = typeof source === "string" ? source : source.id;
    const b = typeof target === "string" ? target : target.id;
    return a < b ? `${a}|${b}|${type}` : `${b}|${a}|${type}`;
  }

  function jaccard(setA, setB) {
    const intersectionSize = [...setA].filter((item) => setB.has(item)).length;
    const unionSize = new Set([...setA, ...setB]).size;
    if (!unionSize) return 0;
    return intersectionSize / unionSize;
  }

  async function fetchLinks(title) {
    const collected = new Set();
    let plContinue;

    do {
      const params = new URLSearchParams({
        action: "query",
        format: "json",
        prop: "links",
        plnamespace: "0",
        pllimit: "max",
        titles: title,
        origin: "*"
      });

      if (plContinue) {
        params.set("plcontinue", plContinue);
      }

      const data = await requestJson(`${API_BASE}?${params.toString()}`);
      const page = extractFirstPage(data);
      if (!page || !page.links) break;

      page.links.forEach((link) => {
        const normalized = normalizeTitle(link.title);
        if (normalized && !normalized.startsWith("List_of_")) {
          collected.add(normalized);
        }
      });

      plContinue = data.continue?.plcontinue;
    } while (plContinue && collected.size < 800);

    return Array.from(collected);
  }

  async function fetchCategories(title) {
    const collected = new Set();
    let clContinue;

    do {
      const params = new URLSearchParams({
        action: "query",
        format: "json",
        prop: "categories",
        cllimit: "max",
        clshow: "!hidden",
        titles: title,
        origin: "*"
      });

      if (clContinue) {
        params.set("clcontinue", clContinue);
      }

      const data = await requestJson(`${API_BASE}?${params.toString()}`);
      const page = extractFirstPage(data);
      if (!page || !page.categories) break;

      page.categories.forEach((category) => {
        const name = category.title.replace(/^Category:/, "");
        if (!isGenericCategory(name)) {
          collected.add(name);
        }
      });

      clContinue = data.continue?.clcontinue;
    } while (clContinue && collected.size < 160);

    return Array.from(collected);
  }

  function isGenericCategory(name) {
    return (
      /^Articles? /.test(name) ||
      /^Use /.test(name) ||
      /^Pages /.test(name) ||
      /^CS1 /.test(name) ||
      /^Good articles/.test(name) ||
      /^Wikipedia /.test(name)
    );
  }

  async function fetchSummary(title) {
    try {
      const response = await fetch(`${REST_SUMMARY_BASE}${encodeURIComponent(title)}`, {
        headers: {
          Accept: "application/json"
        }
      });
      if (!response.ok) return null;
      return await response.json();
    } catch (error) {
      console.warn("Summary request failed", error);
      return null;
    }
  }

  async function requestJson(url) {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Wikipedia API error (${response.status}).`);
    }
    const data = await response.json();
    if (data.error) {
      throw new Error(data.error.info || "Wikipedia API returned an error.");
    }
    return data;
  }

  function extractFirstPage(data) {
    if (!data?.query?.pages) return null;
    const pages = data.query.pages;
    const firstKey = Object.keys(pages)[0];
    return firstKey ? pages[firstKey] : null;
  }

  function normalizeTitle(raw) {
    if (!raw) return "";
    return raw
      .toString()
      .trim()
      .replace(/\s+/g, " ")
      .replace(/ /g, "_");
  }

  function prettifyTitle(title) {
    return title.replace(/_/g, " ");
  }

  class ForceGraph {
    constructor(containerSelector) {
      this.container = document.querySelector(containerSelector);
      const size = this.container.getBoundingClientRect();
      this.width = size.width || this.container.offsetWidth || 800;
      this.height = size.height || this.container.offsetHeight || 600;

      this.svg = d3
        .select(this.container)
        .append("svg")
        .attr("width", this.width)
        .attr("height", this.height);

      this.inner = this.svg.append("g").attr("class", "graph-inner");
      this.linkGroup = this.inner.append("g").attr("class", "links");
      this.nodeGroup = this.inner.append("g").attr("class", "nodes");
      this.labelGroup = this.inner.append("g").attr("class", "labels");

      this.simulation = d3
        .forceSimulation()
        .force(
          "link",
          d3
            .forceLink()
            .id((d) => d.id)
            .distance((d) => this.linkDistance(d))
            .strength((d) => this.linkStrength(d))
        )
        .force("charge", d3.forceManyBody().strength(-220))
        .force("center", d3.forceCenter(this.width / 2, this.height / 2))
        .force("collision", d3.forceCollide().radius((d) => this.nodeRadius(d) + 6).strength(0.75));

      const zoom = d3
        .zoom()
        .scaleExtent([0.05, 6])
        .on("zoom", (event) => {
          this.inner.attr("transform", event.transform);
        });

      this.svg.call(zoom).on("dblclick.zoom", null);
      window.addEventListener("resize", () => this.handleResize());
    }

    update(nodes, links) {
      this.nodes = nodes;
      this.links = links;

      this.linkSelection = this.linkGroup.selectAll("line").data(links, (d) => this.linkKey(d));
      this.linkSelection.exit().remove();
      const linkEnter = this.linkSelection
        .enter()
        .append("line")
        .attr("class", (d) => `link ${d.type}`);

      this.linkSelection = linkEnter.merge(this.linkSelection);
      this.linkSelection
        .attr("class", (d) => `link ${d.type}`)
        .attr("stroke-width", (d) => this.linkStrokeWidth(d));

      this.nodeSelection = this.nodeGroup.selectAll("g").data(nodes, (d) => d.id);
      this.nodeSelection.exit().remove();

      const nodeEnter = this.nodeSelection
        .enter()
        .append("g")
        .attr("class", "node")
        .call(this.dragBehaviour());

      nodeEnter
        .append("circle")
        .attr("r", (d) => this.nodeRadius(d));

      nodeEnter
        .append("title")
        .text((d) => this.nodeTooltip(d));

      this.nodeSelection = nodeEnter.merge(this.nodeSelection);
      this.nodeSelection.select("circle")
        .attr("r", (d) => this.nodeRadius(d))
        .classed("revisited", (d) => d.visitCount > 1)
        .attr("fill", (d) => nodeColor(d));

      this.nodeSelection.select("title").text((d) => this.nodeTooltip(d));

      this.labelSelection = this.labelGroup.selectAll("text").data(nodes, (d) => d.id);
      this.labelSelection.exit().remove();

      const labelEnter = this.labelSelection
        .enter()
        .append("text")
        .attr("dy", "-1em")
        .text((d) => d.title);

      this.labelSelection = labelEnter.merge(this.labelSelection).text((d) => d.title);

      this.simulation.nodes(nodes);
      this.simulation
        .force("link")
        .links(links)
        .distance((d) => this.linkDistance(d))
        .strength((d) => this.linkStrength(d));

      this.simulation.force(
        "collision",
        d3.forceCollide().radius((d) => this.nodeRadius(d) + 6).strength(0.75)
      );

      this.simulation.on("tick", () => this.ticked());
      this.simulation.alpha(0.6).restart();
    }

    reset() {
      this.update([], []);
      this.simulation.alpha(0).stop();
    }

    ticked() {
      if (!this.nodeSelection || !this.linkSelection) return;

      this.linkSelection
        .attr("x1", (d) => d.source.x)
        .attr("y1", (d) => d.source.y)
        .attr("x2", (d) => d.target.x)
        .attr("y2", (d) => d.target.y);

      this.nodeSelection.attr("transform", (d) => `translate(${d.x}, ${d.y})`);

      this.labelSelection
        .attr("x", (d) => d.x)
        .attr("y", (d) => d.y - (this.nodeRadius(d) + 6));
    }

    dragBehaviour() {
      const simulation = this.simulation;
      return d3
        .drag()
        .on("start", (event, d) => {
          if (!event.active) simulation.alphaTarget(0.3).restart();
          d.fx = d.x;
          d.fy = d.y;
        })
        .on("drag", (event, d) => {
          d.fx = event.x;
          d.fy = event.y;
        })
        .on("end", (event, d) => {
          if (!event.active) simulation.alphaTarget(0);
          d.fx = null;
          d.fy = null;
        });
    }

    handleResize() {
      const rect = this.container.getBoundingClientRect();
      this.width = rect.width;
      this.height = rect.height;
      this.svg.attr("width", this.width).attr("height", this.height);
      this.simulation.force("center", d3.forceCenter(this.width / 2, this.height / 2));
      this.simulation.alpha(0.3).restart();
    }

    nodeRadius(node) {
      const base = 10 + Math.log2(node.visitCount + 1) * 6;
      const multiplier = state.seedId && node.id === state.seedId ? 2 : 1;
      return base * (state.nodeScale || 1) * multiplier;
    }

    nodeTooltip(node) {
      const snippet = node.summary.length > 220 ? `${node.summary.slice(0, 217)}…` : node.summary;
      const depthText = Number.isFinite(node.depth) ? node.depth : "–";
      return `${node.title}\nVisits: ${node.visitCount}\nDepth: ${depthText}\nCategories: ${node.categories.slice(0, 5).join(", ")}\n${snippet}`;
    }

    linkStrokeWidth(link) {
      if (link.type === "walk") {
        return Math.min(1 + Math.log2(link.weight + 1), 6);
      }
      return 0.6 + (link.weight || 0) * 4.5;
    }

    linkDistance(link) {
      if (link.type === "walk") {
        return Math.max(60, 160 / Math.sqrt(link.weight || 1));
      }
      const similarity = link.weight || 0;
      return 220 - similarity * 160;
    }

    linkStrength(link) {
      if (link.type === "walk") {
        return 0.35 + Math.min(link.weight, 8) * 0.04;
      }
      return 0.1 + (link.weight || 0) * 0.6;
    }

    linkKey(link) {
      return linkKey(link.source.id || link.source, link.target.id || link.target, link.type);
    }

    randomPoint() {
      const rect = this.container.getBoundingClientRect();
      const cx = rect.width / 2;
      const cy = rect.height / 2;
      return {
        x: cx + (Math.random() - 0.5) * rect.width * 0.2,
        y: cy + (Math.random() - 0.5) * rect.height * 0.2
      };
    }
  }
})();
