// Nonce binding, schema validation and malformed-envelope detection for DeepSeek Web tool
// calls. Split from deepseekWebTools.js so the parser stays small;
// deepseekWebTools.js re-exports the public detectors.

import {
  getRequestedToolNames,
  getToolNonce,
  parseLooseJsonObject,
  resolveRequestedToolName,
} from "./webTools.js";

// ponytail: no ajv@8 in this fork (only ajv@6 via eslint), and bumping the
// locked dependency tree just to type-check tool arguments is not worth it.
// This validates the JSON-Schema subset OpenAI tool `parameters` actually use:
// type/properties/required/items/enum/const/anyOf/oneOf/allOf/not, numeric and
// string bounds, array bounds, additionalProperties. Unknown keywords are
// ignored, matching ajv({strict:false}) semantics closely enough for binding.
const MAX_SCHEMA_DEPTH = 64;

const isRecord = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

function matchesType(value, type) {
  if (type === "integer") return typeof value === "number" && Number.isInteger(value);
  if (type === "number") return typeof value === "number";
  if (type === "object") return isRecord(value);
  if (type === "array") return Array.isArray(value);
  if (type === "null") return value === null;
  if (type === "boolean") return typeof value === "boolean";
  if (type === "string") return typeof value === "string";
  return true;
}

function deepEqual(a, b) {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, i) => deepEqual(item, b[i]));
  }
  if (isRecord(a) && isRecord(b)) {
    const ak = Object.keys(a);
    const bk = Object.keys(b);
    return ak.length === bk.length && ak.every((k) => k in b && deepEqual(a[k], b[k]));
  }
  return false;
}

function validateValue(value, schema, depth) {
  if (schema === true) return true;
  if (schema === false) return false;
  if (!isRecord(schema)) return true;
  if (depth > MAX_SCHEMA_DEPTH) return false;

  if (schema.nullable === true && value === null) return true;

  if (Array.isArray(schema.allOf) && !schema.allOf.every((s) => validateValue(value, s, depth + 1))) {
    return false;
  }
  if (Array.isArray(schema.anyOf) && !schema.anyOf.some((s) => validateValue(value, s, depth + 1))) {
    return false;
  }
  if (Array.isArray(schema.oneOf)) {
    const hits = schema.oneOf.filter((s) => validateValue(value, s, depth + 1)).length;
    if (hits !== 1) return false;
  }
  if (schema.not !== undefined && validateValue(value, schema.not, depth + 1)) return false;

  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => matchesType(value, t))) return false;
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((item) => deepEqual(item, value))) return false;
  if (schema.const !== undefined && !deepEqual(schema.const, value)) return false;

  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) return false;
    if (typeof schema.maximum === "number" && value > schema.maximum) return false;
    if (typeof schema.exclusiveMinimum === "number" && value <= schema.exclusiveMinimum) return false;
    if (typeof schema.exclusiveMaximum === "number" && value >= schema.exclusiveMaximum) return false;
    if (typeof schema.multipleOf === "number" && schema.multipleOf > 0 && value % schema.multipleOf !== 0) return false;
  }

  if (typeof value === "string") {
    if (typeof schema.minLength === "number" && value.length < schema.minLength) return false;
    if (typeof schema.maxLength === "number" && value.length > schema.maxLength) return false;
    if (typeof schema.pattern === "string") {
      try {
        if (!new RegExp(schema.pattern).test(value)) return false;
      } catch {
        // Uncompilable pattern: ajv throws → null validator → call rejected.
        return false;
      }
    }
  }

  if (Array.isArray(value)) {
    if (typeof schema.minItems === "number" && value.length < schema.minItems) return false;
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems) return false;
    if (Array.isArray(schema.items)) {
      for (let i = 0; i < schema.items.length && i < value.length; i += 1) {
        if (!validateValue(value[i], schema.items[i], depth + 1)) return false;
      }
    } else if (schema.items !== undefined) {
      if (!value.every((item) => validateValue(item, schema.items, depth + 1))) return false;
    }
  }

  if (isRecord(value)) {
    const props = isRecord(schema.properties) ? schema.properties : null;
    if (Array.isArray(schema.required)) {
      for (const key of schema.required) {
        if (!(key in value)) return false;
      }
    }
    if (props) {
      for (const [key, sub] of Object.entries(props)) {
        if (key in value && !validateValue(value[key], sub, depth + 1)) return false;
      }
    }
    if (schema.additionalProperties !== undefined) {
      const known = props ? Object.keys(props) : [];
      const extra = Object.keys(value).filter((key) => !known.includes(key));
      if (schema.additionalProperties === false && extra.length > 0) return false;
      if (isRecord(schema.additionalProperties)) {
        for (const key of extra) {
          if (!validateValue(value[key], schema.additionalProperties, depth + 1)) return false;
        }
      }
    }
  }

  return true;
}

const KNOWN_TYPES = new Set(["string", "number", "integer", "boolean", "object", "array", "null"]);

function compileSchemaValidator(schema) {
  // ajv.compile() throws on a malformed schema and the caller caches null →
  // every call is rejected. Keep that contract for the one shape a client can
  // realistically get wrong (an unknown `type`).
  const types = schema?.type === undefined ? [] : Array.isArray(schema.type) ? schema.type : [schema.type];
  if (types.some((t) => typeof t !== "string" || !KNOWN_TYPES.has(t))) return null;
  return (value) => {
    try {
      return validateValue(value, schema, 0);
    } catch {
      return false;
    }
  };
}

const toolValidatorCache = new WeakMap();

export function asRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : null;
}

function requestedToolDefinition(requestedTools, name) {
  if (!Array.isArray(requestedTools)) return null;
  return requestedTools.find((tool) => tool?.function?.name === name) ?? null;
}

export function validateToolArguments(requestedTools, name, args) {
  const definition = requestedToolDefinition(requestedTools, name);
  if (!definition) return false;
  const schema = definition.function?.parameters;
  if (schema === undefined) return true;
  if ((typeof schema !== "object" || schema === null) && typeof schema !== "boolean") return false;

  let validators = toolValidatorCache.get(requestedTools);
  if (!validators) {
    validators = new Map();
    toolValidatorCache.set(requestedTools, validators);
  }
  let validate = validators.get(name);
  if (validate === undefined) {
    try {
      validate = compileSchemaValidator(schema);
    } catch {
      validate = null;
    }
    validators.set(name, validate);
  }
  return validate ? validate(args) === true : false;
}

/**
 * Binding-aware finaliser for the shared tag/DSML path.
 *
 * `finalizeParsedToolCalls` holds every call to the full nonce + schema contract, which is correct
 * for the shapes this fork parses but rejects upstream's nameless `<tool>`/`<parameter>` shape that
 * carries no JSON body to bind. This variant applies the full contract only to calls whose
 * ARGUMENTS carry `_nonce`, and leaves the rest to upstream's own policy. Note the canonical
 * `<tool>{"name",…,"_nonce"}</tool>` envelope puts `_nonce` at the envelope top level: the shared
 * webTools parser checks it there (only when present) and strips it, so those calls reach this
 * function without `_nonce` and are NOT schema-validated.
 */
export function finalizeBoundCalls(rawText, parsed, requestedTools) {
  if (!parsed.toolCalls) return parsed;
  const nonce = getToolNonce(requestedTools);
  const cleaned = [];
  for (const call of parsed.toolCalls) {
    const args = parseLooseJsonObject(call.function.arguments);
    if (!args) return { content: rawText, toolCalls: null };
    if (!("_nonce" in args)) {
      cleaned.push(call);
      continue;
    }
    if (args._nonce !== nonce) return { content: rawText, toolCalls: null };
    const { _nonce: _boundNonce, ...rest } = args;
    if (!validateToolArguments(requestedTools, call.function.name, rest)) {
      return { content: rawText, toolCalls: null };
    }
    cleaned.push({ ...call, function: { ...call.function, arguments: JSON.stringify(rest) } });
  }
  return { content: parsed.content, toolCalls: cleaned };
}

export function finalizeParsedToolCalls(rawText, parsed, requestedTools) {
  if (!parsed.toolCalls) return parsed;
  const nonce = getToolNonce(requestedTools);
  const cleaned = [];

  for (const call of parsed.toolCalls) {
    const args = parseLooseJsonObject(call.function.arguments);
    if (!args) return { content: rawText, toolCalls: null };
    const nestedNonce = args._nonce;
    if (nestedNonce !== undefined && nestedNonce !== nonce) {
      return { content: rawText, toolCalls: null };
    }
    const { _nonce: _boundNonce, ...cleanArgs } = args;
    if (!validateToolArguments(requestedTools, call.function.name, cleanArgs)) {
      return { content: rawText, toolCalls: null };
    }
    cleaned.push({
      ...call,
      function: { ...call.function, arguments: JSON.stringify(cleanArgs) },
    });
  }

  return { content: parsed.content, toolCalls: cleaned };
}

export function hasMalformedDeepSeekToolMarkup(text) {
  if (typeof text !== "string" || !text.trim()) return false;
  // `\s*`: DeepSeek emits both `<|DSML| invoke` and the no-space `<|DSML|invoke`.
  if (/<\/?(?:｜｜|\|\|?)DSML(?:｜｜|\|\|?)\s*(?:calls|invoke|parameter)\b/i.test(text)) {
    return true;
  }
  return /<\/?(?:tool|tool_call)(?::|\s|>)/i.test(text);
}

/** True only for output shapes that express tool intent but failed safe parsing. */
export function hasMalformedDeepSeekToolIntent(text, requestedTools) {
  if (hasMalformedDeepSeekToolMarkup(text)) return true;
  if (typeof text !== "string" || !text.trim()) return false;

  const parsed = parseLooseJsonObject(text);
  if (!parsed || parsed.arguments === undefined) return false;
  const emittedName =
    [parsed.name, parsed.command].find(
      (value) => typeof value === "string" && value.length > 0
    ) ?? null;
  return (
    !!emittedName && !!resolveRequestedToolName(emittedName, getRequestedToolNames(requestedTools))
  );
}
