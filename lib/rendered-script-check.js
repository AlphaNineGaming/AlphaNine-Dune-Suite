"use strict";

const vm = require("vm");

function renderedInlineJavaScript(html) {
  return [...String(html || "").matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/gi)]
    .filter((match) => !/\bsrc\s*=/i.test(match[1]) && !/\btype=["']application\/json["']/i.test(match[1]))
    .map((match) => match[2])
    .filter((script) => script.trim());
}

function assertRenderedInlineJavaScript(pageName, html) {
  const scripts = renderedInlineJavaScript(html);
  if (!scripts.length) throw new Error(`${pageName} rendered no executable inline JavaScript.`);
  scripts.forEach((script, index) => {
    try { new vm.Script(script, { filename: `${pageName}-inline-${index + 1}.js` }); }
    catch (error) { throw new Error(`${pageName} rendered invalid inline JavaScript: ${error.message}`); }
  });
  return scripts.length;
}

module.exports = { assertRenderedInlineJavaScript, renderedInlineJavaScript };
