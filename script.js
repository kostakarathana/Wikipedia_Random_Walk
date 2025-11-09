(() => {
  const API_BASE = "https://en.wikipedia.org/w/api.php";
  const REST_SUMMARY_BASE = "https://en.wikipedia.org/api/rest_v1/page/summary/";
  const MAX_LOG_ITEMS = 50;
  const SIMILARITY_NEIGHBORS = 3;
  
  const COLOR_GRADIENTS = {
    red: [
      { position: 0, rgb: [255, 255, 255] },
      { position: 0.6, rgb: [185, 28, 28] },
      { position: 1, rgb: [0, 0, 0] }
    ],
    blue: [
      { position: 0, rgb: [255, 255, 255] },
      { position: 0.6, rgb: [37, 99, 235] },
      { position: 1, rgb: [0, 0, 0] }
    ]
  };

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
    nodeScale: 5,
    branchingMultiplier: 1,
    selectedNode: null,
    pathToSeed: new Set(),
    colorGradient: 'red',
    running: false,
    loopPromise: null,
    stepCount: 0,
    currentTitle: null,
    previousTitle: null,
    inFlight: false,
    visitHistory: [],
    renderLogPending: false
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
    updateBranchingDisplay();
    updateUI();
  });

  function cacheControls() {
    controls.form = document.getElementById("start-form");
    controls.startInput = document.getElementById("start-title");
    controls.startBtn = document.getElementById("start-btn");
    controls.pauseBtn = document.getElementById("pause-btn");
    controls.colorBtn = document.getElementById("color-btn");
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
    controls.branchingMultiplier = document.getElementById("branching-multiplier");
    controls.branchingDisplay = document.getElementById("branching-display");
    controls.experimentalWarning = document.getElementById("experimental-warning");
    controls.infoBtn = document.getElementById("info-btn");
    controls.infoDialog = document.getElementById("info-dialog");
    controls.reorganiseBtn = document.getElementById("reorganise-btn");
    controls.homeBtn = document.getElementById("home-btn");
  }

  function attachEvents() {
    if (controls.infoBtn && controls.infoDialog && typeof controls.infoDialog.showModal === "function") {
      controls.infoBtn.addEventListener("click", () => {
        if (!controls.infoDialog) return;
        if (controls.infoDialog.open) {
          controls.infoDialog.close();
          return;
        }
        try {
          controls.infoDialog.showModal();
          controls.infoBtn.setAttribute("aria-expanded", "true");
        } catch (error) {
          console.warn("showModal unavailable", error);
        }
      });

      controls.infoDialog.addEventListener("close", () => {
        controls.infoBtn?.setAttribute("aria-expanded", "false");
        controls.infoBtn?.focus({ preventScroll: true });
      });

      controls.infoDialog.addEventListener("cancel", () => {
        controls.infoBtn?.setAttribute("aria-expanded", "false");
      });
    }

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

    controls.colorBtn.addEventListener("click", () => {
      state.colorGradient = state.colorGradient === 'red' ? 'blue' : 'red';
      setFeedback(`Color changed to ${state.colorGradient}.`, "success");
      if (graph) {
        graph.updateVisuals();
      }
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

    controls.branchingMultiplier?.addEventListener("input", (event) => {
      const value = Number.parseInt(event.target.value, 10);
      if (!Number.isFinite(value) || value < 1 || value > 50) return;
      state.branchingMultiplier = value;
      updateBranchingDisplay();
      updateExperimentalWarning();
    });

    controls.reorganiseBtn?.addEventListener("click", () => {
      reorganiseGraph();
    });

    controls.homeBtn?.addEventListener("click", () => {
      if (graph) {
        graph.resetView();
        setFeedback("View reset to seed node.", "success");
      }
    });
  }

  function reorganiseGraph() {
    const wasRunning = state.running;
    if (wasRunning) {
      pauseWalk();
    }

    setFeedback("Reorganising graph layout...", "success");
    
    if (graph) {
      graph.reorganise();
    }

    setTimeout(() => {
      setFeedback("Graph reorganised.", "success");
      if (wasRunning) {
        resumeWalk();
      }
    }, 100);
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
        // Perform multiple steps based on branching multiplier
        const branchCount = state.branchingMultiplier;
        
        if (branchCount === 1) {
          await performStep();
        } else {
          // Branch from the current node
          await performMultipleBranches(branchCount);
        }
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

  async function performMultipleBranches(branchCount) {
    if (state.inFlight) return;
    state.inFlight = true;

    try {
      if (!state.currentTitle) {
        throw new Error("No active page. Start a walk first.");
      }

      // Get links from current page
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

      // Pick multiple random links (as many as requested or available)
      const availableLinks = availability.links;
      const actualBranchCount = Math.min(branchCount, availableLinks.length);
      
      // Shuffle and take the first N links
      const shuffled = [...availableLinks].sort(() => Math.random() - 0.5);
      const selectedLinks = shuffled.slice(0, actualBranchCount);

      // Visit all selected pages in parallel
      const branches = selectedLinks.map((link) => {
        state.stepCount += 1;
        return visitPage(link, state.stepCount);
      });
      
      await Promise.all(branches);

      // After all branches complete, pick one randomly as the new current
      const newCurrent = selectedLinks[Math.floor(Math.random() * selectedLinks.length)];
      state.currentTitle = newCurrent;
      state.previousTitle = state.walkStack[state.walkStack.length - 2];
      
      // Update the walk stack to include the chosen path
      if (!state.walkStack.includes(newCurrent)) {
        state.walkStack.push(newCurrent);
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

  async function performStepFromNode(nodeId) {
    try {
      const node = state.nodeIndex.get(nodeId);
      if (!node) return;

      // Get links for this specific node
      const links = await fetchLinks(node.title);
      if (!links || links.length === 0) return;

      // Pick random link (excluding parent if we're on the main walk stack)
      const previousTitle = state.walkStack[state.walkStack.length - 2];
      const nextTitle = pickRandomLink(links, previousTitle);
      
      state.stepCount += 1;
      await visitPage(nextTitle, state.stepCount);
    } catch (error) {
      console.error("Branch step failed:", error);
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

  function handleNodeClick(event, node) {
    event.stopPropagation();

    // If clicking the same node, deselect it
    if (state.selectedNode === node.id) {
      state.selectedNode = null;
      state.pathToSeed.clear();
      setFeedback("Selection cleared.", "success");
    } else {
      // Select new node and compute path to seed
      state.selectedNode = node.id;
      const path = findShortestPathToSeed(node.id);
      
      if (path) {
        state.pathToSeed = new Set(path);
        setFeedback(`Showing path from ${node.title} to seed (${path.length} nodes).`, "success");
      } else {
        state.pathToSeed.clear();
        setFeedback(`No path found from ${node.title} to seed.`, "warning");
      }
    }

    if (graph) {
      graph.updateVisuals();
    }
  }

  function findShortestPathToSeed(startId) {
    if (!state.seedId || startId === state.seedId) {
      return [startId];
    }

    // BFS to find shortest path
    const queue = [[startId]];
    const visited = new Set([startId]);

    while (queue.length > 0) {
      const path = queue.shift();
      const current = path[path.length - 1];

      if (current === state.seedId) {
        return path;
      }

      const neighbors = state.adjacency.get(current) || new Set();
      for (const neighbor of neighbors) {
        if (!visited.has(neighbor)) {
          visited.add(neighbor);
          queue.push([...path, neighbor]);
        }
      }
    }

    return null; // No path found
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
    state.selectedNode = null;
    state.pathToSeed.clear();
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
    
    // Defer expensive operations
    requestAnimationFrame(() => {
      graph.update(state.nodes, state.links);
      updateUI();
    });
    
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

    // Optimize by computing similarities only for nodes with categories
    const candidates = [];
    for (let i = 0; i < state.nodes.length; i++) {
      const other = state.nodes[i];
      if (other.id === node.id || !other.categorySet.size) continue;
      
      const similarity = jaccard(node.categorySet, other.categorySet);
      if (similarity > 0) {
        candidates.push({ node: other, similarity });
      }
    }
    
    // Partial sort - only sort enough to get top SIMILARITY_NEIGHBORS
    candidates.sort((a, b) => b.similarity - a.similarity);
    const topCandidates = candidates.slice(0, SIMILARITY_NEIGHBORS);

    for (let i = 0; i < topCandidates.length; i++) {
      upsertSimilarityLink(node.id, topCandidates[i].node.id, topCandidates[i].similarity);
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
    const queue = [state.seedId];
    let head = 0;

    depths.set(state.seedId, 0);

    while (head < queue.length) {
      const current = queue[head++];
      const currentDepth = depths.get(current);
      const neighbors = state.adjacency.get(current);
      if (!neighbors) continue;

      for (const neighbor of neighbors) {
        if (!depths.has(neighbor)) {
          depths.set(neighbor, currentDepth + 1);
          queue.push(neighbor);
        }
      }
    }

    let maxFiniteDepth = 0;
    for (let i = 0; i < state.nodes.length; i++) {
      const node = state.nodes[i];
      const depth = depths.has(node.id) ? depths.get(node.id) : Infinity;
      node.depth = depth;
      if (Number.isFinite(depth) && depth > maxFiniteDepth) {
        maxFiniteDepth = depth;
      }
    }

    state.depths = depths;
    state.maxFiniteDepth = maxFiniteDepth;
  }

  function nodeColor(node) {
    if (state.seedId && node?.id === state.seedId) {
      return "#00ff66";
    }

    // If a node is selected, highlight path in yellow and grey out others
    if (state.selectedNode) {
      if (state.pathToSeed.has(node?.id)) {
        return "#fbbf24"; // Yellow for path nodes
      } else {
        return "rgba(100, 100, 100, 0.2)"; // Grey with 80% transparency
      }
    }

    const depth = Number.isFinite(node?.depth) ? node.depth : 0;
    return depthToColor(depth);
  }

  function depthToColor(depth) {
    if (!Number.isFinite(depth)) {
      return "#000000";
    }

    const denominator = Math.max(state.maxFiniteDepth, 1);
    if (denominator <= 0) {
      return "#ffffff";
    }

    const ratio = Math.min(1, Math.max(0, depth / denominator));
    return interpolateGradientColor(ratio);
  }

  function interpolateGradientColor(t) {
    const gradient = COLOR_GRADIENTS[state.colorGradient];
    
    // Find the two color stops to interpolate between
    let lowerStop = gradient[0];
    let upperStop = gradient[gradient.length - 1];
    
    for (let i = 0; i < gradient.length - 1; i++) {
      if (t >= gradient[i].position && t <= gradient[i + 1].position) {
        lowerStop = gradient[i];
        upperStop = gradient[i + 1];
        break;
      }
    }
    
    // Calculate local t between the two stops
    const range = upperStop.position - lowerStop.position;
    const localT = range > 0 ? (t - lowerStop.position) / range : 0;
    
    // Interpolate RGB values
    const r = Math.round(lowerStop.rgb[0] + (upperStop.rgb[0] - lowerStop.rgb[0]) * localT);
    const g = Math.round(lowerStop.rgb[1] + (upperStop.rgb[1] - lowerStop.rgb[1]) * localT);
    const b = Math.round(lowerStop.rgb[2] + (upperStop.rgb[2] - lowerStop.rgb[2]) * localT);

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

    // Defer DOM update to next frame
    if (!state.renderLogPending) {
      state.renderLogPending = true;
      requestAnimationFrame(() => {
        renderVisitLog();
        state.renderLogPending = false;
      });
    }
  }

  function renderVisitLog() {
    const list = controls.visitLog;
    if (!list) return;
    
    // Use DocumentFragment for batch DOM operations
    const fragment = document.createDocumentFragment();

    for (let i = 0; i < state.visitHistory.length; i++) {
      const entry = state.visitHistory[i];
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

      fragment.appendChild(li);
    }
    
    list.innerHTML = "";
    list.appendChild(fragment);
  }

  function updateUI() {
    controls.stepCount.textContent = String(state.stepCount);
    controls.uniqueCount.textContent = String(state.nodes.length);
    const currentNode = state.currentTitle ? state.nodeIndex.get(state.currentTitle) : null;
    controls.currentPage.textContent = currentNode ? currentNode.title : "–";
    controls.maxDistance.textContent = String(state.maxFiniteDepth ?? 0);

    // Count link types in a single pass
    let walkLinks = 0;
    let similarityLinks = 0;
    for (let i = 0; i < state.links.length; i++) {
      const link = state.links[i];
      if (link.type === "walk") {
        walkLinks++;
      } else if (link.type === "similarity") {
        similarityLinks++;
      }
    }
    controls.walkLinkCount.textContent = String(walkLinks);
    controls.similarityCount.textContent = String(similarityLinks);

    controls.pauseBtn.disabled = !state.currentTitle;
    controls.resetBtn.disabled = !state.currentTitle && !state.nodes.length;
    controls.colorBtn.disabled = !state.nodes.length;
    controls.reorganiseBtn.disabled = state.running || !state.nodes.length;
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

  function updateBranchingDisplay() {
    if (!controls.branchingDisplay || !controls.branchingMultiplier) return;
    controls.branchingMultiplier.value = String(state.branchingMultiplier);
    controls.branchingDisplay.textContent = `${state.branchingMultiplier}×`;
  }

  function updateExperimentalWarning() {
    if (!controls.experimentalWarning) return;
    // Show warning when branching multiplier is above 15
    if (state.branchingMultiplier > 15) {
      controls.experimentalWarning.style.display = "block";
    } else {
      controls.experimentalWarning.style.display = "none";
    }
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
    let intersectionSize = 0;
    const smallerSet = setA.size < setB.size ? setA : setB;
    const largerSet = setA.size < setB.size ? setB : setA;
    
    for (const item of smallerSet) {
      if (largerSet.has(item)) {
        intersectionSize++;
      }
    }
    
    const unionSize = setA.size + setB.size - intersectionSize;
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
        .attr("height", this.height)
        .on("click", () => {
          // Clear selection when clicking background
          if (state.selectedNode) {
            state.selectedNode = null;
            state.pathToSeed.clear();
            setFeedback("Selection cleared.", "success");
            this.update(state.nodes, state.links);
          }
        });

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
        .force("charge", d3.forceManyBody().strength(-1600))
        .force("center", d3.forceCenter(this.width / 2, this.height / 2))
        .force("collision", d3.forceCollide().radius((d) => this.nodeRadius(d) + 32).strength(0.9))
        .force("radial", null) // Placeholder for radial constraint
        .alphaDecay(0.03)
        .velocityDecay(0.4);

      this.currentZoomLevel = 1; // Track zoom level

      const zoom = d3
        .zoom()
        .scaleExtent([0.01, 10])
        .on("zoom", (event) => {
          this.inner.attr("transform", event.transform);
          this.currentZoomLevel = event.transform.k;
          this.updateLabelVisibility();
        });

      this.svg.call(zoom).on("dblclick.zoom", null);
      this.zoom = zoom; // Store zoom behavior for reset
      window.addEventListener("resize", () => this.handleResize());
    }

    update(nodes, links) {
      this.nodes = nodes;
      this.links = links;

      // Optimize link updates
      this.linkSelection = this.linkGroup.selectAll("line").data(links, (d) => this.linkKey(d));
      this.linkSelection.exit().remove();
      const linkEnter = this.linkSelection
        .enter()
        .append("line")
        .attr("class", (d) => `link ${d.type}`);

      this.linkSelection = linkEnter.merge(this.linkSelection);
      
      // Cache path check state to avoid repeated calls
      const hasPathHighlight = state.selectedNode && state.pathToSeed.size > 0;
      
      this.linkSelection
        .attr("class", (d) => `link ${d.type}`)
        .classed("path-highlight", hasPathHighlight ? (d) => this.isLinkOnPath(d) : false)
        .attr("stroke-width", (d) => this.linkStrokeWidth(d));

      // Optimize node updates
      this.nodeSelection = this.nodeGroup.selectAll("g").data(nodes, (d) => d.id);
      this.nodeSelection.exit().remove();

      const nodeEnter = this.nodeSelection
        .enter()
        .append("g")
        .attr("class", "node")
        .on("click", (event, d) => handleNodeClick(event, d));

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
        .classed("path-highlight", hasPathHighlight ? (d) => state.pathToSeed.has(d.id) : false)
        .attr("fill", (d) => nodeColor(d));

      this.nodeSelection.select("title").text((d) => this.nodeTooltip(d));

      this.labelSelection = this.labelGroup.selectAll("text").data(nodes, (d) => d.id);
      this.labelSelection.exit().remove();

      const labelEnter = this.labelSelection
        .enter()
        .append("text")
        .attr("dy", "-1em")
        .attr("font-size", "26px")
        .text((d) => d.title);

      this.labelSelection = labelEnter.merge(this.labelSelection)
        .attr("font-size", "26px")
        .text((d) => d.title);
      
      // Update label visibility based on zoom level
      this.updateLabelVisibility();

      this.simulation.nodes(nodes);
      this.simulation
        .force("link")
        .links(links)
        .distance((d) => this.linkDistance(d))
        .strength((d) => this.linkStrength(d));

      this.simulation.force(
        "collision",
        d3.forceCollide().radius((d) => this.nodeRadius(d) + 16).strength(0.9)
      );

      // Ensure tick handler is set
      this.simulation.on("tick", () => this.ticked());

      // Only restart if simulation has stopped or is very low energy
      // For large graphs, use lower alpha to settle faster
      const targetAlpha = this.nodes.length > 500 ? 0.15 : 0.3;
      
      if (this.simulation.alpha() < 0.001) {
        this.simulation.alpha(targetAlpha).restart();
      } else {
        // Just reheat slightly if already running
        this.simulation.alpha(Math.min(this.simulation.alpha() + 0.05, targetAlpha));
      }
      
      // For very large graphs, stop the simulation after it settles
      if (this.nodes.length > 300) {
        setTimeout(() => {
          if (this.simulation.alpha() < 0.05) {
            this.simulation.alpha(0).stop();
          }
        }, 3000);
      }
    }

    updateVisuals() {
      // Update visual attributes only, without restarting physics
      const hasPathHighlight = state.selectedNode && state.pathToSeed.size > 0;
      
      // Update link visuals
      if (this.linkSelection) {
        this.linkSelection
          .classed("path-highlight", hasPathHighlight ? (d) => this.isLinkOnPath(d) : false);
      }
      
      // Update node visuals
      if (this.nodeSelection) {
        this.nodeSelection.select("circle")
          .classed("path-highlight", hasPathHighlight ? (d) => state.pathToSeed.has(d.id) : false)
          .attr("fill", (d) => nodeColor(d));
      }
    }

    updateLabelVisibility() {
      if (!this.labelSelection) return;
      
      // Show labels when zoomed in beyond 0.17x (very zoomed out - 3x less restrictive than before)
      const showLabels = this.currentZoomLevel >= 0.17;
      this.labelSelection.style("display", showLabels ? null : "none");
    }

    reset() {
      this.update([], []);
      this.simulation.alpha(0).stop();
    }

    reorganise() {
      // Clear all fixed positions
      for (let i = 0; i < this.nodes.length; i++) {
        const node = this.nodes[i];
        node.fx = null;
        node.fy = null;
      }

      // Place seed node at center
      const centerX = this.width / 2;
      const centerY = this.height / 2;

      if (state.seedId) {
        const seedNode = this.nodes.find(n => n.id === state.seedId);
        if (seedNode) {
          seedNode.x = centerX;
          seedNode.y = centerY;
          seedNode.vx = 0;
          seedNode.vy = 0;
        }
      }

      // Group nodes by depth
      const nodesByDepth = new Map();
      for (let i = 0; i < this.nodes.length; i++) {
        const node = this.nodes[i];
        if (node.id === state.seedId) continue;
        
        const depth = Number.isFinite(node.depth) ? node.depth : Infinity;
        if (!nodesByDepth.has(depth)) {
          nodesByDepth.set(depth, []);
        }
        nodesByDepth.get(depth).push(node);
      }

      // Calculate target radii for each depth
      const depths = Array.from(nodesByDepth.keys()).sort((a, b) => a - b);
      const baseRadius = Math.min(this.width, this.height) * 0.15;
      const targetRadii = new Map();

      for (let d = 0; d < depths.length; d++) {
        const depth = depths[d];
        targetRadii.set(depth, baseRadius * (1 + depth * 0.8));
      }

      // Store target radius on each node
      for (let i = 0; i < this.nodes.length; i++) {
        const node = this.nodes[i];
        if (node.id === state.seedId) {
          node.targetRadius = 0;
        } else {
          const depth = Number.isFinite(node.depth) ? node.depth : Infinity;
          node.targetRadius = targetRadii.get(depth) || baseRadius * 10;
        }
      }

      // Initial angular placement - cluster by connectivity
      for (let d = 0; d < depths.length; d++) {
        const depth = depths[d];
        const nodesAtDepth = nodesByDepth.get(depth);
        const radius = targetRadii.get(depth);
        
        // Group nodes by their primary parent (most common connection at depth-1)
        const nodeGroups = this.clusterByParent(nodesAtDepth);
        
        let angleOffset = 0;
        for (const group of nodeGroups) {
          const angleSpan = (group.length / nodesAtDepth.length) * 2 * Math.PI;
          
          for (let i = 0; i < group.length; i++) {
            const node = group[i];
            const angle = angleOffset + (i / group.length) * angleSpan;
            node.x = centerX + radius * Math.cos(angle);
            node.y = centerY + radius * Math.sin(angle);
            node.vx = 0;
            node.vy = 0;
          }
          
          angleOffset += angleSpan;
        }
      }

      // Apply radial constraint force
      const radialForce = d3.forceRadial()
        .radius((d) => d.targetRadius || 0)
        .x(centerX)
        .y(centerY)
        .strength(0.8);

      this.simulation.force("radial", radialForce);

      // Full restart with high energy
      this.simulation.alpha(1).alphaTarget(0).restart();

      // Remove radial force after settling and stop simulation completely
      setTimeout(() => {
        this.simulation.force("radial", null);
        this.simulation.alpha(0).stop();
        // Force a final tick to update label positions
        this.ticked();
      }, 5000);
    }

    clusterByParent(nodes) {
      // Group nodes by which node at previous depth they connect to most
      const groups = new Map();
      
      for (const node of nodes) {
        let bestParent = null;
        let maxConnections = 0;
        
        // Find the parent node (at depth-1) with most connections to this node
        const neighbors = state.adjacency.get(node.id) || new Set();
        for (const neighborId of neighbors) {
          const neighbor = state.nodeIndex.get(neighborId);
          if (neighbor && neighbor.depth === node.depth - 1) {
            const connectionCount = 1; // Could weight by link weight here
            if (connectionCount > maxConnections) {
              maxConnections = connectionCount;
              bestParent = neighborId;
            }
          }
        }
        
        const groupKey = bestParent || 'orphan';
        if (!groups.has(groupKey)) {
          groups.set(groupKey, []);
        }
        groups.get(groupKey).push(node);
      }
      
      return Array.from(groups.values());
    }

    resetView() {
      // Reset zoom to identity (scale 1, no translation)
      this.svg.transition()
        .duration(750)
        .call(this.zoom.transform, d3.zoomIdentity);

      // Center on seed node if it exists
      if (state.seedId) {
        const seedNode = this.nodes.find(n => n.id === state.seedId);
        if (seedNode) {
          const transform = d3.zoomIdentity
            .translate(this.width / 2, this.height / 2)
            .scale(1)
            .translate(-seedNode.x, -seedNode.y);
          
          this.svg.transition()
            .duration(750)
            .call(this.zoom.transform, transform);
        }
      }
    }

    ticked() {
      if (!this.nodeSelection || !this.linkSelection) return;

      // Batch DOM updates for better performance
      this.linkSelection
        .attr("x1", (d) => d.source.x)
        .attr("y1", (d) => d.source.y)
        .attr("x2", (d) => d.target.x)
        .attr("y2", (d) => d.target.y);

      this.nodeSelection.attr("transform", (d) => `translate(${d.x}, ${d.y})`);

      // Always update labels if they exist (removed zoom check since labels need to be positioned even when hidden)
      if (this.labelSelection) {
        this.labelSelection
          .attr("x", (d) => d.x)
          .attr("y", (d) => d.y - (this.nodeRadius(d) + 6));
      }
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

    isLinkOnPath(link) {
      if (!state.selectedNode || state.pathToSeed.size === 0) {
        return false;
      }
      
      const sourceId = typeof link.source === 'object' ? link.source.id : link.source;
      const targetId = typeof link.target === 'object' ? link.target.id : link.target;
      
      // Check if both endpoints are on the path
      return state.pathToSeed.has(sourceId) && state.pathToSeed.has(targetId);
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
        return Math.max(240, 640 / Math.sqrt(link.weight || 1));
      }
      const similarity = link.weight || 0;
      return 880 - similarity * 640;
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
