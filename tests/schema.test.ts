import { getSchemaForPath, reconcileAndApplySchema } from '@/function/schema';
import { updateVariables } from '@/function/update_variables';
import { useDataStore } from '@/store';
import { type MvuData, type ObjectSchemaNode, variable_events } from '@/variable_def';
import { registerSchemaTests } from './helpers/schema_suite';
import { describe } from '@jest/globals';

describe('without mvu_zod', registerSchemaTests);

describe('native additionalProperties setting', () => {
    let variables: MvuData & { stat_data: Record<string, any> };

    beforeEach(() => {
        (globalThis as any).SillyTavern.extensionSettings = {};
        variables = {
            stat_data: {
                person: { B: { existing: 'old', closed: [1, 2] } },
                items: [{ existing: 'old', closed: [1] }],
                scalar: 1,
            },
            initialized_lorebooks: {},
            schema: { type: 'object', properties: {} },
        };
        reconcileAndApplySchema(variables);
    });

    test('rejects undeclared fields by default', async () => {
        const errors: string[] = [];
        expect(useDataStore().settings.additionalProperties).toBe(false);
        expect(
            await updateVariables(
                '<JSONPatch>[{"op":"insert","path":"/person/B/C","value":"content"}]</JSONPatch>',
                variables,
                errors
            )
        ).toBe(false);
        expect(variables.stat_data.person.B).not.toHaveProperty('C');
        expect(errors).toHaveLength(1);
    });

    test.each([
        '<JSONPatch>[{"op":"insert","path":"/person/B/C","value":"content"}]</JSONPatch>',
        '<JSONPatch>[{"op":"add","path":"/person/B/C","value":"content"}]</JSONPatch>',
        "_.insert('person.B', 'C', 'content');",
        "_.assign('person.B', 'C', 'content');",
    ])('adds an object field without changing extensible: %s', async message => {
        useDataStore().settings.additionalProperties = true;
        const errors: string[] = [];
        expect(await updateVariables(message, variables, errors)).toBe(true);
        expect(variables.stat_data.person.B.C).toBe('content');
        expect(getSchemaForPath(variables.schema, 'person.B')).toMatchObject({
            extensible: false,
            recursiveExtensible: false,
            properties: { C: { type: 'string' } },
        });
        expect(errors).toEqual([]);
    });

    test('switching off blocks new keys but retains and can update fields already added', async () => {
        const store = useDataStore();
        store.settings.additionalProperties = true;
        await updateVariables("_.insert('person.B', 'C', 'content');", variables);
        store.settings.additionalProperties = false;
        const errors: string[] = [];
        expect(
            await updateVariables("_.insert('person.B', 'D', 'other');", variables, errors)
        ).toBe(false);
        expect(variables.stat_data.person.B.C).toBe('content');
        expect(variables.stat_data.person.B).not.toHaveProperty('D');
        expect(errors).toHaveLength(1);
        expect(await updateVariables("_.set('person.B.C', 'updated');", variables)).toBe(true);
        expect(variables.stat_data.person.B.C).toBe('updated');
    });

    test('leaves explicitly extensible objects usable when the switch is off', async () => {
        const schema = getSchemaForPath(variables.schema, 'person.B') as ObjectSchemaNode;
        schema.extensible = true;
        expect(await updateVariables("_.insert('person.B', 'C', 'content');", variables)).toBe(
            true
        );
        expect(variables.stat_data.person.B.C).toBe('content');
    });

    test('allows new fields at the root and inside objects in closed arrays', async () => {
        useDataStore().settings.additionalProperties = true;
        const errors: string[] = [];
        const message = `<JSONPatch>${JSON.stringify([
            { op: 'insert', path: '/newRoot', value: { score: 1 } },
            { op: 'insert', path: '/items/0/C', value: 'content' },
        ])}</JSONPatch>`;
        expect(await updateVariables(message, variables, errors)).toBe(true);
        expect(variables.stat_data.newRoot).toEqual({ score: 1 });
        expect(variables.stat_data.items[0].C).toBe('content');
        expect(getSchemaForPath(variables.schema, 'items')).toMatchObject({ extensible: false });
        expect(errors).toEqual([]);
    });

    test('allows object merges only after opting in', async () => {
        const message = "_.assign('person.B', { C: { score: 1 } });";
        expect(await updateVariables(message, variables, [])).toBe(false);
        useDataStore().settings.additionalProperties = true;
        const errors: string[] = [];
        expect(await updateVariables(message, variables, errors)).toBe(true);
        expect(variables.stat_data.person.B).toEqual({
            existing: 'old',
            closed: [1, 2],
            C: { score: 1 },
        });
        expect(getSchemaForPath(variables.schema, 'person.B')).toMatchObject({ extensible: false });
        expect(errors).toEqual([]);
    });

    test.each([
        "_.insert('person.B.closed', 3);",
        '<JSONPatch>[{"op":"insert","path":"/person/B/closed/-","value":3}]</JSONPatch>',
        "_.assign('person.B', { C: 'content', closed: [1, 2, 3] });",
        "_.assign('person.B', { C: 'content', closed: { 2: 3 } });",
        "_.assign('', { items: [{ closed: [1, 2] }] });",
    ])('does not relax closed arrays or partially apply a rejected merge: %s', async message => {
        useDataStore().settings.additionalProperties = true;
        const original = structuredClone(variables.stat_data);
        const errors: string[] = [];
        expect(await updateVariables(message, variables, errors)).toBe(false);
        expect(variables.stat_data).toEqual(original);
        expect(errors).toHaveLength(1);
    });

    test('does not expand an array when its stored schema incorrectly says object', async () => {
        useDataStore().settings.additionalProperties = true;
        variables.stat_data.person.B = [];
        const errors: string[] = [];
        expect(await updateVariables("_.insert('person.B', 'content');", variables, errors)).toBe(
            false
        );
        expect(variables.stat_data.person.B).toEqual([]);
        expect(errors).toHaveLength(1);
    });

    test.each([
        '<JSONPatch>[{"op":"insert","path":"/scalar/C","value":1}]</JSONPatch>',
        '<JSONPatch>[{"op":"insert","path":"/person/missing/C","value":1}]</JSONPatch>',
        '<JSONPatch>[{"op":"remove","path":"/person/B/existing"}]</JSONPatch>',
    ])('preserves primitive, missing-parent, and required-field guards: %s', async message => {
        useDataStore().settings.additionalProperties = true;
        const original = structuredClone(variables.stat_data);
        const errors: string[] = [];
        expect(await updateVariables(message, variables, errors)).toBe(false);
        expect(variables.stat_data).toEqual(original);
        expect(errors).toHaveLength(1);
    });

    test.each(['__proto__', 'constructor', 'prototype'])(
        'rejects unsafe inserted keys: %s',
        async key => {
            useDataStore().settings.additionalProperties = true;
            const errors: string[] = [];
            const message = `<JSONPatch>${JSON.stringify([
                { op: 'insert', path: `/person/B/${key}`, value: { unsafe: true } },
            ])}</JSONPatch>`;
            expect(await updateVariables(message, variables, errors)).toBe(false);
            expect(Object.hasOwn(variables.stat_data.person.B, key)).toBe(false);
            expect(Object.getPrototypeOf(variables.stat_data.person.B)).toBe(Object.prototype);
            expect(errors).toHaveLength(1);
        }
    );

    test.each([
        '<JSONPatch>[{"op":"insert","path":"/person/B/__proto__/unsafe","value":true}]</JSONPatch>',
        '<JSONPatch>[{"op":"insert","path":"/person/B/C","value":{"nested":{"__proto__":{"unsafe":true}}}}]</JSONPatch>',
        "_.assign('person.B', { nested: { constructor: { prototype: { unsafe: true } } } });",
    ])('rejects unsafe paths and nested payloads before mutation: %s', async message => {
        useDataStore().settings.additionalProperties = true;
        const original = structuredClone(variables.stat_data);
        const errors: string[] = [];
        expect(await updateVariables(message, variables, errors)).toBe(false);
        expect(variables.stat_data).toEqual(original);
        expect(Object.hasOwn(Object.prototype, 'unsafe')).toBe(false);
        expect(errors).toHaveLength(1);
    });

    test('checks templates for unsafe keys before applying an inserted value', async () => {
        useDataStore().settings.additionalProperties = true;
        const schema = getSchemaForPath(variables.schema, 'person.B') as ObjectSchemaNode;
        schema.template = JSON.parse('{"nested":{"__proto__":{"unsafe":true}}}');
        const errors: string[] = [];
        expect(await updateVariables("_.insert('person.B', 'C', {});", variables, errors)).toBe(
            false
        );
        expect(variables.stat_data.person.B).not.toHaveProperty('C');
        expect(errors).toHaveLength(1);
    });

    test.each([
        "_.insert('person.B', '$meta', { extensible: true });",
        "_.insert('person.B', '$internal', {});",
        "_.assign('person.B', { $meta: { recursiveExtensible: true } });",
        "_.insert('person.B', 'C', { nested: { $meta: { recursiveExtensible: true } } });",
        "_.insert('person.B', 'C', [{ $arrayMeta: true, $meta: { extensible: true } }]);",
        "_.insert('person.B', 'C', ['$__META_EXTENSIBLE__$']);",
    ])('does not let model metadata make the override permanent: %s', async message => {
        useDataStore().settings.additionalProperties = true;
        const original = structuredClone(variables.stat_data);
        const errors: string[] = [];
        expect(await updateVariables(message, variables, errors)).toBe(false);
        expect(variables.stat_data).toEqual(original);
        expect(getSchemaForPath(variables.schema, 'person.B')).toMatchObject({
            extensible: false,
            recursiveExtensible: false,
        });
        expect(errors).toHaveLength(1);
    });

    test('preserves author-defined template metadata and explicit array expansion', async () => {
        useDataStore().settings.additionalProperties = true;
        const schema = getSchemaForPath(variables.schema, 'person.B') as ObjectSchemaNode;
        schema.template = { $meta: { extensible: true }, score: 1 };
        const errors: string[] = [];
        expect(await updateVariables("_.insert('person.B', 'C', {});", variables, errors)).toBe(
            true
        );
        expect(variables.stat_data.person.B.C).toEqual({ score: 1 });
        expect(getSchemaForPath(variables.schema, 'person.B.C')).toMatchObject({
            extensible: true,
        });
        expect(getSchemaForPath(variables.schema, 'person.B')).toMatchObject({ extensible: false });

        const arraySchema = getSchemaForPath(variables.schema, 'person.B.closed');
        if (arraySchema?.type !== 'array') throw new Error('Expected the array schema');
        arraySchema.extensible = true;
        expect(
            await updateVariables("_.assign('person.B', { closed: [1, 2, 3] });", variables, errors)
        ).toBe(true);
        expect(variables.stat_data.person.B.closed).toEqual([1, 2, 3]);
        expect(errors).toEqual([]);
    });

    test('does not bypass commands rejected by the MVU Zod hook', async () => {
        useDataStore().settings.additionalProperties = true;
        eventOn(
            variable_events.COMMAND_PARSED + '_for_zod',
            (_variables, commands, _content, onError) => {
                commands.length = 0;
                onError('Zod rejected the undeclared field');
            }
        );
        const errors: string[] = [];
        expect(
            await updateVariables("_.insert('person.B', 'C', 'content');", variables, errors)
        ).toBe(false);
        expect(variables.stat_data.person.B).not.toHaveProperty('C');
        expect(errors).toEqual(['Zod rejected the undeclared field']);
    });
});
