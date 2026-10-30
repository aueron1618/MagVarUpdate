import { updateVariables } from '@/function/update_variables';
import { type MvuData, variable_events } from '@/variable_def';
import { registerJsonPatchTests } from './helpers/json_patch_suite';
import { describe } from '@jest/globals';

describe('without mvu_zod', registerJsonPatchTests);

describe.each([undefined, false, true])('native array replace with strictSet=%s', strictSet => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    test.each([
        { label: 'two-item array', value: ['text3', 'text4'] },
        { label: 'empty array', value: [] },
        { label: 'shorter array', value: ['text3'] },
        { label: 'longer array', value: ['text3', 'text4', 'text5'] },
        { label: 'nested array', value: [['text3', 'text4'], 'text5'] },
        { label: 'scalar', value: 'text3' },
        { label: 'null', value: null },
    ])('replaces the whole value with $label', async ({ value }) => {
        const oldValue = ['text', 'text2'];
        const variables: MvuData = {
            stat_data: { items: [...oldValue] },
            initialized_lorebooks: {},
            schema: { type: 'object', properties: {}, strictSet },
        };
        const message = `<JsonPatch>${JSON.stringify([
            { op: 'replace', path: '/items', value },
        ])}</JsonPatch>`;

        expect(await updateVariables(message, variables)).toBe(true);

        expect(variables.stat_data).toEqual({ items: value });
        const newValueDisplay = typeof value === 'string' ? value : JSON.stringify(value);
        const change = `${JSON.stringify(oldValue)}->${newValueDisplay} (json_patch)`;
        expect(variables.display_data?.items).toBe(change);
        expect(variables.delta_data?.items).toBe(change);
        expect(eventEmit).toHaveBeenCalledWith(
            variable_events.SINGLE_VARIABLE_UPDATED,
            variables.stat_data,
            '["items"]',
            oldValue,
            value
        );
    });

    test('only replaces the selected element when an index is explicit', async () => {
        const variables: MvuData = {
            stat_data: { items: ['text', 'text2'] },
            initialized_lorebooks: {},
            schema: { type: 'object', properties: {}, strictSet },
        };

        await updateVariables(
            '<JsonPatch>[{"op":"replace","path":"/items/0","value":["text3","text4"]}]</JsonPatch>',
            variables
        );

        expect(variables.stat_data).toEqual({ items: [['text3', 'text4'], 'text2'] });
    });
});
