import { updateVariables } from '@/function/update_variables';
import { useDataStore } from '@/store';
import { type MvuData, variable_events } from '@/variable_def';

describe('updateVariables error collection', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        (globalThis as any).toastr = { warning: jest.fn(), error: jest.fn() };
        useDataStore().settings.通知.变量更新出错 = true;
    });

    const createVariables = (): MvuData => ({
        stat_data: { hp: 72 },
        initialized_lorebooks: {},
        schema: { type: 'object', properties: {} },
    });

    describe.each(['delta', 'add'])('%s numeric formatting', operation => {
        const messageFor = (delta: unknown) =>
            operation === 'delta'
                ? `<JsonPatch>${JSON.stringify([{ op: 'delta', path: '/hp', value: delta }])}</JsonPatch>`
                : `_.add('hp', ${JSON.stringify(delta)});`;

        test.each([
            { value: '100,000', delta: 1000, expected: '101,000' },
            { value: '100,000', delta: -1000, expected: '99,000' },
            { value: '-100,000', delta: 1000, expected: '-99,000' },
            { value: '1,234,567.89', delta: 0.11, expected: '1,234,568' },
            { value: '1,000', delta: -1000, expected: '0' },
            { value: ' +100,000.50 ', delta: -0.25, expected: '100,000.25' },
            { value: 100000, delta: '1,000', expected: 101000 },
            { value: '100,000', delta: '-1,000.25', expected: '98,999.75' },
            { value: ['100,000', 'balance'], delta: -1000, expected: ['99,000', 'balance'] },
            { value: [100000, 'balance'], delta: '1,000', expected: [101000, 'balance'] },
            { value: '999,999', delta: 1, expected: '1,000,000' },
            { value: '1,000', delta: -2001, expected: '-1,001' },
            { value: '1,234.123456', delta: 0.000001, expected: '1,234.123457' },
            { value: '0,000.0000001', delta: 0.0000002, expected: '0.0000003' },
            { value: '1000', delta: '1,000', expected: '2000' },
            { value: 999, delta: 1, expected: 1000 },
            {
                value: '1,000,000,000,000,000,000,000',
                delta: 1e21,
                expected: '2,000,000,000,000,000,000,000',
            },
            { value: 72, delta: 8, expected: 80 },
            {
                value: 'Wed, 28 Oct 2026 08:00:00 GMT',
                delta: 1000,
                expected: '2026-10-28T08:00:01.000Z',
            },
        ])('updates $value by $delta without errors', async ({ value, delta, expected }) => {
            const variables = createVariables();
            variables.stat_data.hp = _.cloneDeep(value);
            const errors: string[] = [];

            await expect(updateVariables(messageFor(delta), variables, errors)).resolves.toBe(true);

            expect(variables.stat_data.hp).toEqual(expected);
            expect(errors).toEqual([]);
            expect(toastr.warning).not.toHaveBeenCalled();
            expect(eventEmit).toHaveBeenCalledWith(
                variable_events.SINGLE_VARIABLE_UPDATED,
                variables.stat_data,
                operation === 'delta' ? '["hp"]' : 'hp',
                value,
                expected
            );
            expect(variables.delta_data?.hp).toContain(
                `${JSON.stringify(Array.isArray(value) ? value[0] : value)}->${JSON.stringify(Array.isArray(expected) ? expected[0] : expected)}`
            );
        });

        test('continues arithmetic after a grouped result falls below one thousand', async () => {
            const variables = createVariables();
            variables.stat_data.hp = '1,000';
            const errors: string[] = [];

            await updateVariables(messageFor(-1), variables, errors);
            expect(variables.stat_data.hp).toBe('999');

            await updateVariables(messageFor(-1), variables, errors);
            expect(variables.stat_data.hp).toBe('998');
            expect(errors).toEqual([]);
        });

        test.each([100000, '100,000'])('keeps zero delta a no-op for %p', async value => {
            const variables = createVariables();
            variables.stat_data.hp = value;
            const errors: string[] = [];

            await expect(updateVariables(messageFor(0), variables, errors)).resolves.toBe(false);

            expect(variables.stat_data.hp).toBe(value);
            expect(errors).toEqual([]);
        });

        test.each(['', '   ', '100,00', '1,000 coins', `1${',000'.repeat(103)}`, null, true])(
            'rejects invalid delta %p without changing the formatted value',
            async delta => {
                const variables = createVariables();
                variables.stat_data.hp = '100,000';
                const errors: string[] = [];

                await expect(updateVariables(messageFor(delta), variables, errors)).resolves.toBe(
                    false
                );

                expect(variables.stat_data.hp).toBe('100,000');
                expect(variables.delta_data).toEqual({});
                expect(errors).toHaveLength(1);
                expect(eventEmit).not.toHaveBeenCalledWith(
                    variable_events.SINGLE_VARIABLE_UPDATED,
                    expect.anything(),
                    expect.anything(),
                    expect.anything(),
                    expect.anything()
                );
            }
        );
    });

    test('preserves comma-grouped strings outside delta arithmetic', async () => {
        const variables = createVariables();
        variables.stat_data.hp = '';
        const errors: string[] = [];

        await updateVariables(`_.set('hp', "100,000");`, variables, errors);

        expect(variables.stat_data.hp).toBe('100,000');
        expect(errors).toEqual([]);
    });

    test.each([true, false])('appends every native error with notifications %p', async enabled => {
        useDataStore().settings.通知.变量更新出错 = enabled;
        const errors = ['earlier error'];
        const variables = createVariables();
        const result = await updateVariables(
            "_.set('missing', 1); _.add('other', 2); _.set('hp', 80);",
            variables,
            errors
        );
        expect(result).toBe(true);
        expect(variables.stat_data.hp).toBe(80);
        expect(errors).toHaveLength(3);
        expect(errors[0]).toBe('earlier error');
        expect(errors[1]).toContain("_.set('missing', 1)");
        expect(errors[2]).toContain("_.add('other', 2)");
        expect(toastr.warning).not.toHaveBeenCalled();
    });

    test('keeps the old toast behavior when no collection array is provided', async () => {
        await expect(updateVariables("_.set('missing', 1);", createVariables())).resolves.toBe(
            false
        );
        expect(toastr.warning).toHaveBeenCalledTimes(1);
    });

    test('passes the reporter only as the fourth Zod event argument', async () => {
        const errors: string[] = [];
        const variables = createVariables();
        const message = "_.set('hp', 80);";
        eventOn(
            variable_events.COMMAND_PARSED + '_for_zod',
            (_variables, _commands, content, onError) => {
                expect(content).toBe(message);
                onError('first Zod error');
                onError('second Zod error');
            }
        );
        await updateVariables(message, variables, errors);
        expect(errors).toEqual(['first Zod error', 'second Zod error']);
        expect(eventEmit).toHaveBeenCalledWith(
            variable_events.COMMAND_PARSED + '_for_zod',
            variables,
            expect.any(Array),
            message,
            expect.any(Function)
        );
        expect(eventEmit).toHaveBeenCalledWith(
            variable_events.COMMAND_PARSED,
            variables,
            expect.any(Array),
            message
        );
        expect(toastr.warning).not.toHaveBeenCalled();
    });

    test('leaves the Zod reporter undefined in legacy notification mode', async () => {
        eventOn(
            variable_events.COMMAND_PARSED + '_for_zod',
            (_variables, _commands, _content, onError) => {
                expect(onError).toBeUndefined();
            }
        );
        await updateVariables('', createVariables());
    });

    test('does not add errors for a successful update', async () => {
        const errors: string[] = [];
        await updateVariables("_.set('hp', 80);", createVariables(), errors);
        expect(errors).toEqual([]);
        expect(toastr.warning).not.toHaveBeenCalled();
    });
});
