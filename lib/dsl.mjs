// q_plat expression language. No eval, dynamic imports, property access or user JS.
export const OPERATORS = {
  lag: [2, 2],
  delta: [2, 2],
  returns: [2, 2],
  ts_mean: [2, 2],
  ts_std: [2, 2],
  ts_rank: [2, 2],
  rank: [1, 1],
  zscore: [1, 1],
  where: [3, 3],
  clip: [3, 3],
  group_rank: [1, 1],
  group_demean: [1, 1],
  abs: [1, 1],
};
export const FIELDS = ["open", "high", "low", "close", "volume"];
const temporal = new Set([
  "lag",
  "delta",
  "returns",
  "ts_mean",
  "ts_std",
  "ts_rank",
]);
export class DslError extends Error {
  constructor(message, token = {}) {
    super(message);
    this.name = "DslError";
    this.line = token.line ?? 1;
    this.column = token.column ?? 1;
  }
}
export function parse(code, fields = FIELDS) {
  if (typeof code !== "string" || code.length > 6000)
    throw new DslError("Code must be text, at most 6,000 characters.");
  const tokens = [];
  let line = 1,
    column = 1,
    i = 0;
  while (i < code.length) {
    const c = code[i];
    if (c === "#") {
      while (i < code.length && code[i] !== "\n") {
        i++;
        column++;
      }
      continue;
    }
    if (c === "\n") {
      tokens.push({ v: ";", line, column });
      line++;
      column = 1;
      i++;
      continue;
    }
    if (/\s/.test(c)) {
      i++;
      column++;
      continue;
    }
    const match =
      /^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?|^[A-Za-z_][A-Za-z_0-9]*|^(?:>=|<=|==|!=|[+\-*/(),=<>;])/.exec(
        code.slice(i),
      );
    if (!match)
      throw new DslError(
        `Unexpected character '${c}'. Only the documented DSL is allowed.`,
        { line, column },
      );
    tokens.push({ v: match[0], line, column });
    i += match[0].length;
    column += match[0].length;
    if (tokens.length > 1500)
      throw new DslError("Expression is too large.", tokens.at(-1));
  }
  tokens.push({ v: "EOF", line, column });
  let p = 0,
    nodes = 0;
  const variables = new Set(),
    statements = [];
  const peek = () => tokens[p];
  const take = (v) => {
    const t = tokens[p++];
    if (v && t.v !== v)
      throw new DslError(`Expected '${v}', found '${t.v}'.`, t);
    return t;
  };
  const precedence = {
    or: 1,
    and: 2,
    "==": 3,
    "!=": 3,
    ">": 3,
    "<": 3,
    ">=": 3,
    "<=": 3,
    "+": 4,
    "-": 4,
    "*": 5,
    "/": 5,
  };
  function expr(min = 0, depth = 0) {
    if (depth > 40 || ++nodes > 500)
      throw new DslError("AST limit exceeded (500 nodes / depth 40).", peek());
    const t = take();
    let left;
    if (t.v === "-" || t.v === "+" || t.v === "not")
      left = { type: "unary", op: t.v, arg: expr(6, depth + 1), ...t };
    else if (t.v === "(") {
      left = expr(0, depth + 1);
      take(")");
    } else if (/^(?:\d|\.)/.test(t.v)) {
      const value = Number(t.v);
      if (!Number.isFinite(value))
        throw new DslError("Number must be finite.", t);
      left = { type: "number", value, ...t };
    } else if (/^[A-Za-z_]/.test(t.v)) {
      if (peek().v === "(") {
        if (!Object.hasOwn(OPERATORS, t.v))
          throw new DslError(`Unknown operator '${t.v}'.`, t);
        take("(");
        const args = [];
        if (peek().v !== ")") {
          do {
            args.push(expr(0, depth + 1));
            if (peek().v !== ",") break;
            take(",");
          } while (true);
        }
        take(")");
        const [lo, hi] = OPERATORS[t.v];
        if (args.length < lo || args.length > hi)
          throw new DslError(`${t.v} expects ${lo} arguments.`, t);
        if (
          temporal.has(t.v) &&
          (args[1].type !== "number" ||
            !Number.isInteger(args[1].value) ||
            args[1].value < 1 ||
            args[1].value > 252)
        )
          throw new DslError(
            "Window/lag must be an integer literal from 1 to 252. Negative offsets reveal the future.",
            args[1],
          );
        left = { type: "call", name: t.v, args, ...t };
      } else {
        if (!fields.includes(t.v) && !variables.has(t.v))
          throw new DslError(
            `Unknown or forbidden field '${t.v}'. Available: ${fields.join(", ")}.`,
            t,
          );
        left = { type: "variable", name: t.v, ...t };
      }
    } else throw new DslError(`Expected expression, found '${t.v}'.`, t);
    while (Object.hasOwn(precedence, peek().v) && precedence[peek().v] >= min) {
      const op = take();
      left = {
        type: "binary",
        op: op.v,
        left,
        right: expr(precedence[op.v] + 1, depth + 1),
        ...op,
      };
    }
    return left;
  }
  while (peek().v !== "EOF") {
    if (peek().v === ";") {
      take();
      continue;
    }
    const name = take();
    if (
      !/^[A-Za-z][A-Za-z_0-9]*$/.test(name.v) ||
      fields.includes(name.v) ||
      Object.hasOwn(OPERATORS, name.v) ||
      ["and", "or", "not"].includes(name.v) ||
      variables.has(name.v)
    )
      throw new DslError(
        "Use a unique variable name; fields/operators cannot be reassigned.",
        name,
      );
    take("=");
    const value = expr();
    if (![";", "EOF"].includes(peek().v))
      throw new DslError("Expected a newline between assignments.", peek());
    variables.add(name.v);
    statements.push({ name: name.v, value, line: name.line });
    if (statements.length > 32)
      throw new DslError("At most 32 variables are allowed.", name);
  }
  if (!variables.has("score"))
    throw new DslError("Assign a final variable named score.");
  return { version: 1, statements, fields };
}
export const finite = (x) => typeof x === "number" && Number.isFinite(x);
export const mean = (x) => {
  const a = x.filter(finite);
  return a.length ? a.reduce((s, v) => s + v, 0) / a.length : null;
};
export function std(x) {
  const a = x.filter(finite),
    m = mean(a);
  return a.length > 1
    ? Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / (a.length - 1))
    : null;
}
export function ranks(values, percentile = true) {
  const sorted = values
    .map((v, i) => ({ v, i }))
    .filter((x) => finite(x.v))
    .sort((a, b) => a.v - b.v);
  const out = values.map(() => null);
  let i = 0;
  while (i < sorted.length) {
    let j = i + 1;
    while (j < sorted.length && sorted[j].v === sorted[i].v) j++;
    const mid = (i + j - 1) / 2;
    for (let k = i; k < j; k++)
      out[sorted[k].i] = percentile
        ? sorted.length === 1
          ? 0.5
          : mid / (sorted.length - 1)
        : mid + 1;
    i = j;
  }
  return out;
}
export function makePanel(rows) {
  const dates = [...new Set(rows.map((r) => r.date))].sort(),
    assets = [...new Set(rows.map((r) => r.asset))].sort();
  if (dates.length > 5000 || assets.length > 64 || rows.length > 70000)
    throw new Error("Panel limit exceeded.");
  const ti = new Map(dates.map((x, i) => [x, i])),
    ai = new Map(assets.map((x, i) => [x, i]));
  const matrix = dates.map(() => assets.map(() => null));
  for (const r of rows) {
    const t = ti.get(r.date),
      a = ai.get(r.asset);
    if (matrix[t][a]) throw new Error("Duplicate asset/time.");
    matrix[t][a] = r;
  }
  return { dates, assets, matrix };
}
export function evaluate(ast, panel) {
  const { matrix, assets, dates } = panel,
    T = dates.length,
    A = assets.length;
  const map = (fn) =>
    Array.from({ length: T }, (_, t) =>
      Array.from({ length: A }, (_, a) => {
        const x = fn(t, a);
        return finite(x) ? x : null;
      }),
    );
  const env = Object.create(null);
  for (const f of ast.fields) env[f] = map((t, a) => matrix[t][a]?.[f] ?? null);
  function calc(n) {
    if (n.type === "number") return map(() => n.value);
    if (n.type === "variable") return env[n.name];
    if (n.type === "unary") {
      const x = calc(n.arg);
      return map((t, a) =>
        x[t][a] === null
          ? null
          : n.op === "-"
            ? -x[t][a]
            : n.op === "not"
              ? +!x[t][a]
              : x[t][a],
      );
    }
    if (n.type === "binary") {
      const x = calc(n.left),
        y = calc(n.right);
      return map((t, a) => {
        const v = x[t][a],
          w = y[t][a];
        if (v === null || w === null) return null;
        switch (n.op) {
          case "+":
            return v + w;
          case "-":
            return v - w;
          case "*":
            return v * w;
          case "/":
            return w === 0 ? null : v / w;
          case ">":
            return +(v > w);
          case "<":
            return +(v < w);
          case ">=":
            return +(v >= w);
          case "<=":
            return +(v <= w);
          case "==":
            return +(v === w);
          case "!=":
            return +(v !== w);
          case "and":
            return +(!!v && !!w);
          case "or":
            return +(!!v || !!w);
        }
      });
    }
    const args = n.args.map(calc),
      x = args[0],
      w = n.args[1]?.value;
    if (temporal.has(n.name))
      return map((t, a) => {
        if (n.name === "lag") return t >= w ? x[t - w][a] : null;
        if (n.name === "returns" || n.name === "delta")
          return t >= w && finite(x[t][a]) && finite(x[t - w][a])
            ? n.name === "delta"
              ? x[t][a] - x[t - w][a]
              : x[t - w][a] === 0
                ? null
                : x[t][a] / x[t - w][a] - 1
            : null;
        if (t < w - 1) return null;
        const slice = x.slice(t - w + 1, t + 1).map((r) => r[a]);
        if (slice.some((v) => !finite(v))) return null;
        return n.name === "ts_mean"
          ? mean(slice)
          : n.name === "ts_std"
            ? std(slice)
            : ranks(slice).at(-1);
      });
    if (["rank", "zscore", "group_rank", "group_demean"].includes(n.name)) {
      const grouped = n.name.startsWith("group_");
      return x.map((row, t) => {
        const out = Array(A).fill(null),
          groups = new Map();
        row.forEach((v, a) => {
          const g = grouped ? matrix[t][a]?.group : "all";
          if (g == null) return;
          if (!groups.has(g)) groups.set(g, []);
          groups.get(g).push(a);
        });
        for (const members of groups.values()) {
          const vals = members.map((a) => row[a]),
            m = mean(vals),
            s = std(vals),
            r = ranks(vals);
          members.forEach((a, i) => {
            out[a] = !finite(vals[i])
              ? null
              : n.name.endsWith("rank")
                ? r[i]
                : n.name === "zscore"
                  ? s > 0
                    ? (vals[i] - m) / s
                    : null
                  : vals[i] - m;
          });
        }
        return out;
      });
    }
    if (n.name === "abs")
      return map((t, a) => (x[t][a] === null ? null : Math.abs(x[t][a])));
    if (n.name === "where")
      return map((t, a) =>
        x[t][a] === null ? null : x[t][a] ? args[1][t][a] : args[2][t][a],
      );
    if (n.name === "clip")
      return map((t, a) =>
        [x[t][a], args[1][t][a], args[2][t][a]].every(finite) &&
        args[1][t][a] <= args[2][t][a]
          ? Math.max(args[1][t][a], Math.min(args[2][t][a], x[t][a]))
          : null,
      );
    throw new Error("Unsupported AST node.");
  }
  for (const s of ast.statements) env[s.name] = calc(s.value);
  return Object.fromEntries(ast.statements.map((s) => [s.name, env[s.name]]));
}
