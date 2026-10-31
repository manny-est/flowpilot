"use strict";

function percent(value, total) {
  return total ? (value / total * 100).toFixed(1) : "0.0";
}

function formatResultLine(summary) {
  const total = Number(summary.total) || 0;
  return "PROMPT-FUZZ RESULT: " + summary.model +
    " code " + summary.codePassed + "/" + total + " (" + percent(summary.codePassed, total) + "%) ·" +
    " judge " + summary.judgePassed + "/" + total + " (" + percent(summary.judgePassed, total) + "%) ·" +
    " both " + summary.bothPassed + "/" + total + " (" + percent(summary.bothPassed, total) + "%) ·" +
    " errors " + (Number(summary.errors) || 0);
}

function categoryTable(results) {
  const categories = {};
  results.forEach(function (result) {
    const category = result.category || "uncategorized";
    const row = categories[category] || (categories[category] = { total: 0, code: 0, judge: 0, both: 0 });
    row.total++;
    if (result.code && result.code.pass) { row.code++; }
    if (result.judge && result.judge.did_what_was_asked === true) { row.judge++; }
    if (result.code && result.code.pass && result.judge && result.judge.did_what_was_asked === true) { row.both++; }
  });
  return categories;
}

module.exports = { formatResultLine: formatResultLine, categoryTable: categoryTable };
