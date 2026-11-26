'use strict';

/**
 * A small PostgREST-faithful double for the Supabase query builder.
 *
 * WHY IT EXISTS
 *   The previous support tests used a hand-written fake that returned WHOLE rows
 *   whatever the code selected. That hides two real production failures:
 *
 *     1. a projection that forgets a column (support_messages.via) looks fine,
 *        because the fake ignored the projection;
 *     2. a write that sends a column the database does not have looks fine,
 *        because the fake accepted any key.
 *
 *   This double therefore behaves like the real thing in the four ways that
 *   matter here:
 *      * SELECT returns ONLY the requested columns, in the requested order;
 *      * INSERT/UPDATE of an unknown column fails with PGRST204
 *        ("Could not find the 'x' column of 'y' in the schema cache");
 *      * UNIQUE constraints raise 23505, exactly like Postgres;
 *      * filters, ordering, limits, `single()` (PGRST116/406 on 0 or >1 rows)
 *        and `maybeSingle()` behave as documented.
 *
 *   It is deliberately NOT a full PostgREST: no joins, no embedded resources, no
 *   RLS. Anything a test needs beyond the list above should be added explicitly
 *   rather than silently ignored, so a new query shape cannot pass by accident.
 */

function clone(value) {
    return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function postgrestError(code, message) {
    return { code: code, message: message, details: null, hint: null };
}

function unknownColumn(table, column) {
    return postgrestError('PGRST204',
        "Could not find the '" + column + "' column of '" + table + "' in the schema cache");
}

function parseColumns(list) {
    if (!list || list === '*') return null;
    return String(list).split(',').map(function (part) {
        return part.trim();
    }).filter(Boolean);
}

function compare(a, b) {
    if (a === b) return 0;
    if (a === null || a === undefined) return 1;
    if (b === null || b === undefined) return -1;
    if (typeof a === 'number' && typeof b === 'number') return a - b;
    return String(a) < String(b) ? -1 : 1;
}

/**
 * @param {object} options
 * @param {object} options.schema  { table: { columns: ['id','body'], unique: [['conversation_id','client_message_id']] } }
 * @param {object} [options.rows]  seed rows per table
 */
function createFakeSupabase(options) {
    const opts = options || {};
    const schema = opts.schema || {};
    const tables = {};
    const sequences = {};
    const calls = [];

    Object.keys(schema).forEach(function (table) {
        tables[table] = clone((opts.rows && opts.rows[table]) || []);
        const highest = tables[table].reduce(function (max, row) {
            const id = Number(row.id);
            return Number.isFinite(id) && id > max ? id : max;
        }, 0);
        sequences[table] = highest + 1;
    });

    function tableSpec(table) {
        const spec = schema[table];
        if (!spec) throw new Error('fake-postgrest: unknown table ' + table);
        return spec;
    }

    function checkColumns(table, payload) {
        const spec = tableSpec(table);
        const known = spec.columns;
        const keys = Object.keys(payload || {});
        for (const key of keys) {
            if (known.indexOf(key) === -1) return unknownColumn(table, key);
        }
        return null;
    }

    function violatesUnique(table, candidate, ignoreIndex) {
        const spec = tableSpec(table);
        const sets = spec.unique || [];
        for (const cols of sets) {
            // A NULL in any member means "not comparable" for a partial unique
            // index; Postgres keeps multiple NULLs.
            if (cols.some(function (c) { return candidate[c] === null || candidate[c] === undefined; })) continue;
            const clash = tables[table].some(function (row, index) {
                if (index === ignoreIndex) return false;
                return cols.every(function (c) { return String(row[c]) === String(candidate[c]); });
            });
            if (clash) return postgrestError('23505', 'duplicate key value violates unique constraint "' + table + '_' + cols.join('_') + '_key"');
        }
        return null;
    }

    function project(row, columns) {
        if (!columns) return clone(row);
        const out = {};
        columns.forEach(function (column) { out[column] = row[column] === undefined ? null : clone(row[column]); });
        return out;
    }

    function matches(row, filters) {
        return filters.every(function (f) {
            const value = row[f.column];
            switch (f.op) {
                case 'eq': return String(value) === String(f.value);
                case 'neq': return String(value) !== String(f.value);
                case 'gt': return value !== null && value !== undefined && Number(value) > Number(f.value);
                case 'gte': return value !== null && value !== undefined && Number(value) >= Number(f.value);
                case 'lt': return value !== null && value !== undefined && Number(value) < Number(f.value);
                case 'lte': return value !== null && value !== undefined && Number(value) <= Number(f.value);
                case 'is': return (f.value === null ? (value === null || value === undefined) : value === f.value);
                case 'in': return f.value.map(String).indexOf(String(value)) !== -1;
                case 'ilike': {
                    const pattern = String(f.value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*');
                    return new RegExp('^' + pattern + '$', 'i').test(String(value === null || value === undefined ? '' : value));
                }
                case 'like': {
                    const pattern = String(f.value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*');
                    return new RegExp('^' + pattern + '$').test(String(value === null || value === undefined ? '' : value));
                }
                default: throw new Error('fake-postgrest: unsupported filter ' + f.op);
            }
        });
    }

    function makeQuery(table) {
        const state = {
            action: 'select',
            columns: null,
            filters: [],
            orders: [],
            limit: null,
            payload: null,
            mode: 'many'
        };

        function execute() {
            try {
                if (state.action === 'select') return { data: selectRows(), error: null };
                if (state.action === 'insert') return { data: insertRows(), error: null };
                if (state.action === 'update') return { data: updateRows(), error: null };
                if (state.action === 'delete') return { data: deleteRows(), error: null };
                return { data: null, error: postgrestError('PGRST000', 'unsupported action') };
            } catch (err) {
                return { data: null, error: err.postgrest || postgrestError('PGRST000', err.message || 'error') };
            }
        }

        function failWith(error) {
            const err = new Error(error.message);
            err.postgrest = error;
            throw err;
        }

        function selectRows() {
            const spec = tableSpec(table);
            if (state.columns) {
                for (const column of state.columns) {
                    if (spec.columns.indexOf(column) === -1) failWith(unknownColumn(table, column));
                }
            }
            let rows = tables[table].filter(function (row) { return matches(row, state.filters); });
            state.orders.forEach(function (order) {
                rows = rows.slice().sort(function (a, b) {
                    const result = compare(a[order.column], b[order.column]);
                    return order.ascending === false ? -result : result;
                });
            });
            if (state.limit !== null) rows = rows.slice(0, state.limit);
            return finish(rows);
        }

        // `.single()` / `.maybeSingle()` shape the RESULT of every action, not
        // just a select - supabase-js returns one object for an insert that asks
        // for it, and code that stores `.insert(...).select().single()` depends
        // on that.
        function finish(rows) {
            const projected = rows.map(function (row) { return project(row, state.columns); });
            if (state.mode === 'single') {
                if (projected.length !== 1) failWith(postgrestError('PGRST116', 'JSON object requested, multiple (or no) rows returned'));
                return projected[0];
            }
            if (state.mode === 'maybeSingle') return projected[0] || null;
            return projected;
        }

        function insertRows() {
            spec_assertWritable();
            const spec = tableSpec(table);
            const input = Array.isArray(state.payload) ? state.payload : [state.payload];
            const created = input.map(function (row) {
                const candidate = Object.assign({}, row);
                spec.columns.forEach(function (column) {
                    if (candidate[column] === undefined) {
                        candidate[column] = spec.defaults && spec.defaults[column] !== undefined
                            ? spec.defaults[column]
                            : null;
                    }
                });
                // Migration triggers are modelled explicitly by the caller, so a
                // "column filled by a BEFORE INSERT trigger" path is testable.
                if (typeof spec.beforeInsert === 'function') {
                    const patch = spec.beforeInsert(candidate, spec);
                    if (patch) Object.assign(candidate, patch);
                }
                if (candidate.id === null || candidate.id === undefined) {
                    // Identity column: derive from what is ACTUALLY in the table, so a
                    // row written by an RPC (a test's rpc map) cannot collide with the
                    // next insert. Colliding ids would corrupt every dedupe assertion.
                    candidate.id = tables[table].reduce(function (max, row) {
                        const id = Number(row.id);
                        return Number.isFinite(id) && id > max ? id : max;
                    }, 0) + 1;
                }
                sequences[table] = Math.max(sequences[table], Number(candidate.id) + 1);
                const unique = violatesUnique(table, candidate, -1);
                if (unique) failWith(unique);
                tables[table].push(candidate);
                return candidate;
            });
            return finish(created);
        }

        function updateRows() {
            spec_assertWritable();
            const patched = [];
            tables[table].forEach(function (row, index) {
                if (!matches(row, state.filters)) return;
                const candidate = Object.assign({}, row, state.payload);
                const unique = violatesUnique(table, candidate, index);
                if (unique) failWith(unique);
                Object.assign(row, state.payload);
                patched.push(row);
            });
            return finish(patched);
        }

        function deleteRows() {
            const removed = [];
            for (let i = tables[table].length - 1; i >= 0; i -= 1) {
                if (matches(tables[table][i], state.filters)) removed.push(tables[table].splice(i, 1)[0]);
            }
            return finish(removed);
        }

        function spec_assertWritable() {
            const error = checkColumns(table, state.payload || {});
            if (error) failWith(error);
        }

        const builder = {
            select(columns) {
                state.columns = parseColumns(columns);
                return builder;
            },
            insert(payload) {
                state.action = 'insert';
                state.payload = clone(payload);
                return builder;
            },
            update(patch) {
                state.action = 'update';
                state.payload = clone(patch);
                return builder;
            },
            delete() {
                state.action = 'delete';
                return builder;
            },
            eq(column, value) { state.filters.push({ op: 'eq', column, value }); return builder; },
            neq(column, value) { state.filters.push({ op: 'neq', column, value }); return builder; },
            gt(column, value) { state.filters.push({ op: 'gt', column, value }); return builder; },
            gte(column, value) { state.filters.push({ op: 'gte', column, value }); return builder; },
            lt(column, value) { state.filters.push({ op: 'lt', column, value }); return builder; },
            lte(column, value) { state.filters.push({ op: 'lte', column, value }); return builder; },
            is(column, value) { state.filters.push({ op: 'is', column, value }); return builder; },
            in(column, values) { state.filters.push({ op: 'in', column, value: values || [] }); return builder; },
            ilike(column, value) { state.filters.push({ op: 'ilike', column, value }); return builder; },
            like(column, value) { state.filters.push({ op: 'like', column, value }); return builder; },
            order(column, orderOptions) {
                const o = orderOptions || {};
                state.orders.push({ column, ascending: o.ascending !== false });
                return builder;
            },
            limit(n) { state.limit = Number(n); return builder; },
            single() { state.mode = 'single'; return builder; },
            maybeSingle() { state.mode = 'maybeSingle'; return builder; },
            then(resolve, reject) { return Promise.resolve(execute()).then(resolve, reject); }
        };
        // supabase-js builders are awaitable AND thenable.
        builder.catch = function (handler) { return Promise.resolve(execute()).catch(handler); };
        return builder;
    }

    const client = {
        from(table) {
            calls.push('from:' + table);
            return makeQuery(table);
        },
        rpc(name, params) {
            calls.push('rpc:' + name);
            const fn = (opts.rpc || {})[name];
            if (!fn) {
                return Promise.resolve({
                    data: null,
                    error: postgrestError('PGRST202', 'Could not find the function public.' + name + ' in the schema cache')
                });
            }
            try {
                return Promise.resolve({ data: fn(params || {}, tables), error: null });
            } catch (err) {
                return Promise.resolve({ data: null, error: err.postgrest || postgrestError('PGRST000', err.message) });
            }
        },
        // Test-only helpers (never used by production code).
        _tables: tables,
        _calls: calls,
        _seed(table, rows) {
            const list = Array.isArray(rows) ? rows : [rows];
            list.forEach(function (row) {
                const spec = tableSpec(table);
                const candidate = Object.assign({}, row);
                spec.columns.forEach(function (column) {
                    if (candidate[column] === undefined) candidate[column] = null;
                });
                if (candidate.id === null || candidate.id === undefined) candidate.id = sequences[table]++;
                else sequences[table] = Math.max(sequences[table], Number(candidate.id) + 1);
                tables[table].push(candidate);
            });
            return list;
        }
    };
    return client;
}

module.exports = { createFakeSupabase, postgrestError, parseColumns };
