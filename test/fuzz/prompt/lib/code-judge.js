"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");

let validator;

function loadValidator() {
  if (validator) { return validator; }
  const source = fs.readFileSync(path.join(__dirname, "..", "..", "..", "..", "lib", "core", "validate.js"), "utf8");
  const context = { RED: { nodes: {} } };
  vm.runInNewContext(source + "\nthis.__flowPilotValidate = { validateFlow: validateFlow };", context, {
    filename: "lib/core/validate.js"
  });
  validator = context.__flowPilotValidate;
  return validator;
}

const TYPE_PORTS = {
  inject: [0, 1], function: [1, 1], change: [1, 1], switch: [1, 2], filter: [1, 1],
  json: [1, 1], xml: [1, 1], csv: [1, 1], delay: [1, 1], trigger: [1, 1],
  "http request": [1, 1], "http in": [0, 1], "http response": [1, 0],
  "mqtt in": [0, 1], "mqtt out": [1, 0], debug: [1, 0], status: [1, 0],
  comment: [0, 0], group: [0, 0], "mqtt-broker": [0, 0], "tls-config": [0, 0]
};

const INSTALLED_TYPES = new Set(Object.keys(TYPE_PORTS).concat([
  "base64", "html", "split", "join", "sort", "batch", "link in", "link out", "link call", "junction"
]));

function clone(value) {
  return value === undefined ? value : JSON.parse(JSON.stringify(value));
}

function graphNodes(graph) {
  const flow = Array.isArray(graph) ? graph : graph && Array.isArray(graph.flow) ? graph.flow : [];
  return flow.filter(function (node) { return node && node.type !== "tab" && node.type !== "subflow"; }).map(function (node) {
    const ports = TYPE_PORTS[node.type] || [1, 1];
    return Object.assign({}, clone(node), {
      inputs: typeof node.inputs === "number" ? node.inputs : ports[0],
      outputs: typeof node.outputs === "number" ? node.outputs : ports[1],
      wires: Array.isArray(node.wires) ? node.wires : []
    });
  });
}

function edges(nodes) {
  const byId = new Map(nodes.map(function (node) { return [node.id, node]; }));
  const result = [];
  const seen = new Set();
  nodes.forEach(function (node) {
    node.wires.forEach(function (targets, port) {
      (Array.isArray(targets) ? targets : []).forEach(function (targetId) {
        const key = node.id + "\u0000" + port + "\u0000" + targetId;
        result.push({ from: node.id, fromPort: port, to: targetId, target: byId.get(targetId) || null });
        if (seen.has(key)) { result[result.length - 1].duplicate = true; }
        seen.add(key);
      });
    });
  });
  return result;
}

function hasInput(nodes, nodeId) {
  return edges(nodes).some(function (edge) { return edge.target && edge.to === nodeId; });
}

function nodeNeedsInput(node) {
  return Number(node.inputs) > 0 && node.type !== "group" && !/-broker$|-config$|-server$|-client$/.test(String(node.type || ""));
}

function overlapFailures(nodes) {
  const failures = [];
  const placed = nodes.filter(function (node) {
    return node.type !== "group" && Number.isFinite(Number(node.x)) && Number.isFinite(Number(node.y));
  });
  placed.forEach(function (left, index) {
    placed.slice(index + 1).forEach(function (right) {
      if (left.z !== right.z) { return; }
      const lw = Number(left.width) || 120;
      const rw = Number(right.width) || 120;
      const lh = 40;
      const rh = 40;
      if (Math.abs(Number(left.x) - Number(right.x)) < (lw + rw) / 2 &&
          Math.abs(Number(left.y) - Number(right.y)) < (lh + rh) / 2) {
        failures.push("nodes overlap: " + left.id + " and " + right.id);
      }
    });
  });
  return failures;
}

function typeNames(nodes) {
  return nodes.map(function (node) { return node.type; });
}

function codeChecks(graph, actual) {
  const nodes = graphNodes(graph);
  const allIds = new Set();
  const failures = [];
  nodes.forEach(function (node) {
    if (!node.id) { failures.push("node is missing an id"); }
    if (allIds.has(node.id)) { failures.push("duplicate node id: " + node.id); }
    allIds.add(node.id);
  });
  const graphEdges = edges(nodes);
  graphEdges.forEach(function (edge) {
    if (!edge.target) { failures.push("wire points to missing node: " + edge.to); }
    if (edge.duplicate) { failures.push("duplicate wire: " + edge.from + " -> " + edge.to); }
    const source = nodes.find(function (node) { return node.id === edge.from; });
    if (source && edge.fromPort >= Number(source.outputs)) {
      failures.push("wire uses an invalid output port: " + edge.from + ":" + edge.fromPort);
    }
  });
  nodes.filter(nodeNeedsInput).forEach(function (node) {
    if (!hasInput(nodes, node.id)) { failures.push("node is unwired: " + node.id); }
  });
  overlapFailures(nodes).forEach(function (failure) { failures.push(failure); });

  const validationNodes = nodes.map(clone);
  const validation = loadValidator().validateFlow(validationNodes, {
    allNodes: validationNodes,
    isInstalled: function (type) { return INSTALLED_TYPES.has(type); }
  });
  if (!validation.ok) {
    failures.push.apply(failures, validation.failures.map(function (check) { return check.message; }));
  }
  if (validation.warnings.length) {
    failures.push.apply(failures, validation.warnings.map(function (check) { return "lint: " + check.message; }));
  }
  return { nodes: nodes, edges: graphEdges, failures: failures, validation: validation, types: typeNames(nodes), actual: actual || {} };
}

function expectedChecks(result, expect) {
  const failures = [];
  const fields = [];
  expect = expect || {};
  const nodes = result.nodes;
  const types = result.types;
  function field(name, expected, pass, detail) {
    fields.push({ field: name, expected: expected, pass: pass, detail: detail || undefined });
    if (!pass) { failures.push(detail || (name + " did not match expectation")); }
  }
  (expect.mustContainTypes || []).forEach(function (type) {
    field("mustContainTypes", type, types.indexOf(type) !== -1, "missing required type: " + type);
  });
  (expect.mustNotContainTypes || []).forEach(function (type) {
    field("mustNotContainTypes", type, types.indexOf(type) === -1, "forbidden type present: " + type);
  });
  if (Array.isArray(expect.targetIds)) {
    const touched = new Set((result.actual.touchedIds || []).map(String));
    expect.targetIds.forEach(function (id) {
      field("targetIds", id, touched.has(String(id)), "target was not touched: " + id);
    });
  }
  if (expect.maxNodesAdded !== undefined && Number(result.actual.nodesAdded || 0) > Number(expect.maxNodesAdded)) {
    field("maxNodesAdded", expect.maxNodesAdded, false, "too many nodes added: " + result.actual.nodesAdded);
  } else if (expect.maxNodesAdded !== undefined) {
    field("maxNodesAdded", expect.maxNodesAdded, true);
  }
  if (expect.mustWrite !== undefined && !!result.actual.wrote !== !!expect.mustWrite) {
    field("mustWrite", expect.mustWrite, false, "mustWrite expected " + expect.mustWrite + ", got " + !!result.actual.wrote);
  } else if (expect.mustWrite !== undefined && result.actual.wrote !== undefined) {
    field("mustWrite", expect.mustWrite, true);
  }
  if (expect.action && result.actual.action && expect.action !== result.actual.action) {
    field("action", expect.action, false, "action expected " + expect.action + ", got " + result.actual.action);
  } else if (expect.action && result.actual.action) {
    field("action", expect.action, true);
  }
  if (expect.consent === "ask" && result.actual.consentAsked !== true) {
    field("consent", "ask", false, "expected consent ask");
  } else if (expect.consent !== undefined && result.actual.consentAsked !== undefined) {
    field("consent", expect.consent, expect.consent === "ask" ? result.actual.consentAsked === true : result.actual.consentAsked !== true);
  }
  if (expect.lane && result.actual.lane) {
    field("lane", expect.lane, expect.lane === result.actual.lane, "lane expected " + expect.lane + ", got " + result.actual.lane);
  }
  return { failures: failures, fields: fields };
}

function judgeCode(graph, options) {
  options = options || {};
  const result = codeChecks(graph, options.actual);
  const expected = expectedChecks(result, options.expect || {});
  const failures = result.failures.concat(expected.failures);
  return {
    pass: failures.length === 0,
    failures: failures,
    fields: expected.fields,
    graph: {
      nodes: result.nodes,
      edges: result.edges,
      types: result.types
    },
    validation: result.validation
  };
}

function summarizeGraph(graph) {
  const result = codeChecks(graph, {});
  return {
    nodes: result.nodes.map(function (node) {
      return { id: node.id, type: node.type, name: node.name || "", z: node.z || null,
        keyConfig: Object.keys(node).filter(function (key) {
          return ["id", "type", "name", "z", "x", "y", "wires", "inputs", "outputs"].indexOf(key) === -1;
        }).reduce(function (out, key) { out[key] = node[key]; return out; }, {}) };
    }),
    wires: result.edges.map(function (edge) { return { from: edge.from, fromPort: edge.fromPort, to: edge.to }; })
  };
}

module.exports = { judgeCode: judgeCode, summarizeGraph: summarizeGraph, graphNodes: graphNodes };
