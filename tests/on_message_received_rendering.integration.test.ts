/**
 * 随 AI 输出的渲染时序回归：使用真实 MVU 接收/变量处理链路，模拟宿主 DOM 与渲染通知。
 * ST 1.18.0 saveReply 在接收后格式化正文；StreamingProcessor.finalizeIntermediaryMessage
 * 在接收前已格式化正文，接收后仅发 CHARACTER_MESSAGE_RENDERED。两种情况都只能通知一次。
 */
import { initResponse } from '@/function/update';
import { onMessageReceived } from '@/function/update/on_message_received';
import { handleVariablesInMessage } from '@/function/update_variables';
import { useDataStore } from '@/store';
import { MvuData, variable_events } from '@/variable_def';
import { nextTick } from 'vue';

jest.mock('@/function/update/invoke_extra_model', () => ({
    invokeExtraModelWithStrategy: jest.fn(),
}));
// 必须覆盖生产监听路径，不能让 Jest 专用的无节流路径掩盖延迟执行问题。
jest.mock('@/jest', () => ({ is_jest_environment: false }));

const PLACEHOLDER = '<StatusPlaceHolderImpl/>';
const BODY = '战斗结束。\n<UpdateVariable>_.set("health", 80);</UpdateVariable>';
const renderObserver = jest.fn();

function makeMessage(message: string, variables?: MvuData): SillyTavern.ChatMessage {
    return {
        name: 'Assistant',
        mes: message,
        is_user: false,
        is_system: false,
        swipe_id: 0,
        variables: variables ? [variables] : [{}],
    };
}

function display(message_id: number) {
    return $(`#chat > .mes[mesid="${message_id}"] .mes_text`);
}

function mountMessage(message_id: number) {
    $('#chat').append(`<div class="mes" mesid="${message_id}"><div class="mes_text"></div></div>`);
    display(message_id).html(
        formatAsDisplayedMessage(SillyTavern.chat[message_id].mes, { message_id })
    );
}

const emitRendered = (message_id = 1) =>
    eventEmit(tavern_events.CHARACTER_MESSAGE_RENDERED, message_id, 'normal');

beforeEach(async () => {
    jest.clearAllMocks();
    document.body.innerHTML = '<div id="chat"></div>';
    Object.assign(SillyTavern, {
        extensionSettings: {},
        name2: 'Assistant',
        getCurrentChatId: jest.fn().mockReturnValue('render-chat'),
        chat: [
            makeMessage('初始状态', {
                initialized_lorebooks: {},
                stat_data: { health: 100 },
                schema: { type: 'object', properties: { health: { type: 'number' } } },
            }),
            makeMessage(BODY),
        ],
    });
    jest.mocked(getChatMessages).mockImplementation(id => {
        const message_id = Number(id);
        const message = SillyTavern.chat[message_id];
        return message
            ? [
                  {
                      message_id,
                      name: message.name,
                      role: 'assistant',
                      message: message.mes,
                  } as ChatMessage,
              ]
            : [];
    });
    Object.assign(globalThis, {
        toastr: { warning: jest.fn(), error: jest.fn() },
        retrieveDisplayedMessage: jest.fn(display),
        // 模拟正则将占位符转换为状态栏，必须在变量写入后读取到新状态。
        formatAsDisplayedMessage: jest.fn(
            (text: string, { message_id }: { message_id: number }) => {
                const health = _.get(
                    SillyTavern.chat[message_id],
                    'variables.0.stat_data.health',
                    'unset'
                );
                return _.escape(text).replaceAll(
                    _.escape(PLACEHOLDER),
                    `<div class="status-bar">${health}</div>`
                );
            }
        ),
        updateVariablesWith: jest.fn(async (updater, options) => {
            const message = SillyTavern.chat[options.message_id];
            message.variables![message.swipe_id ?? 0] = updater(
                message.variables![message.swipe_id ?? 0]
            );
        }),
    });
    jest.mocked(setChatMessages).mockImplementation(async (messages, options) => {
        for (const message of messages) {
            if ('message' in message && message.message !== undefined) {
                SillyTavern.chat[message.message_id].mes = message.message;
            }
            if (options?.refresh === 'affected') {
                // 对齐助手 refreshOneMessage：替换正文 DOM，并立即通知渲染器。
                display(message.message_id).html(
                    formatAsDisplayedMessage(SillyTavern.chat[message.message_id].mes, {
                        message_id: message.message_id,
                    })
                );
                await emitRendered(message.message_id);
            }
        }
    });
    const store = useDataStore();
    store.should_enable = true;
    await nextTick();
    store.settings.更新方式 = '随AI输出';
    store.settings.兼容性.额外模型解析非阻塞 = false;
    store.settings.兼容性.更新到聊天变量 = false;
    eventOn(tavern_events.CHARACTER_MESSAGE_RENDERED, renderObserver);
});

afterEach(() => {
    document.body.innerHTML = '';
});

test.each([
    ['非流式', false],
    ['非流式', true],
    ['流式', false],
    ['流式', true],
] as const)('%s，模型已有占位符=%s：只通知一次渲染且显示最新变量', async (mode, supplied) => {
    if (supplied) SillyTavern.chat[1].mes += `\n\n${PLACEHOLDER}`;
    if (mode === '流式') mountMessage(1);
    const stop = initResponse();
    try {
        await eventEmit(tavern_events.MESSAGE_RECEIVED, 1, 'normal');
        expect(renderObserver).not.toHaveBeenCalled();
        expect(SillyTavern.chat[1].mes.split(PLACEHOLDER)).toHaveLength(2);
        expect(_.get(SillyTavern.chat[1], 'variables.0.stat_data.health')).toBe(80);
        if (mode === '非流式') mountMessage(1);
        await emitRendered();
        expect(renderObserver).toHaveBeenCalledTimes(1);
        expect(display(1).find('.status-bar')).toHaveLength(1);
        expect(display(1).find('.status-bar').text()).toBe('80');
        expect(
            jest
                .mocked(setChatMessages)
                .mock.calls.every(([, option]) => option?.refresh === 'none')
        ).toBe(true);
    } finally {
        stop();
    }
});

test('相邻接收事件不被节流推迟到宿主渲染之后', async () => {
    const stop = initResponse();
    try {
        for (const message_id of [1, 2]) {
            if (message_id === 2) SillyTavern.chat.push(makeMessage(BODY));
            mountMessage(message_id);
            await eventEmit(tavern_events.MESSAGE_RECEIVED, message_id, 'normal');
            expect(_.get(SillyTavern.chat[message_id], 'variables.0.stat_data.health')).toBe(80);
            expect(display(message_id).find('.status-bar').text()).toBe('80');
            await emitRendered(message_id);
        }
        expect(renderObserver).toHaveBeenCalledTimes(2);
    } finally {
        stop();
    }
});

test.each(['手动重新处理', '强制调用'] as const)('%s 仍主动刷新一次', async mode => {
    mountMessage(1);
    if (mode === '手动重新处理') await handleVariablesInMessage(1);
    else await onMessageReceived(1, { force: true });
    expect(renderObserver).toHaveBeenCalledTimes(1);
    expect(display(1).find('.status-bar').text()).toBe('80');
    expect(setChatMessages).toHaveBeenLastCalledWith([{ message_id: 1 }], { refresh: 'affected' });
});

test('宿主未等待变量处理就发出渲染事件时，完成后仍补一次必要的刷新', async () => {
    mountMessage(1);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    eventOn(variable_events.VARIABLE_UPDATE_ENDED, async () => {
        entered.resolve();
        await release.promise;
    });
    const handling = onMessageReceived(1);
    await entered.promise;
    await emitRendered();
    release.resolve();
    await handling;
    expect(renderObserver).toHaveBeenCalledTimes(2);
    expect(display(1).find('.status-bar')).toHaveLength(1);
    expect(display(1).find('.status-bar').text()).toBe('80');
});

test('其他楼层的渲染不消费当前楼层的等待状态', async () => {
    mountMessage(1);
    eventOn(variable_events.VARIABLE_UPDATE_ENDED, async () => {
        await emitRendered(0);
    });
    await onMessageReceived(1);
    expect(renderObserver.mock.calls.map(([message_id]) => message_id)).toEqual([0]);
    await emitRendered();
    expect(renderObserver.mock.calls.map(([message_id]) => message_id)).toEqual([0, 1]);
});

test('没有有效变量快照时不刷新，也不残留监听', async () => {
    SillyTavern.chat[0].variables = [{}];
    await onMessageReceived(1);
    expect(setChatMessages).not.toHaveBeenCalled();
    expect(formatAsDisplayedMessage).not.toHaveBeenCalled();
    const temporary = jest
        .mocked(eventOn)
        .mock.calls.filter(
            ([event, listener]) =>
                event === tavern_events.CHARACTER_MESSAGE_RENDERED && listener !== renderObserver
        );
    expect(temporary).toHaveLength(1);
    expect(eventRemoveListener).toHaveBeenCalledWith(...temporary[0]);
});

test('模块卸载时立即释放监听，等待中的处理完成后不再操作 DOM', async () => {
    mountMessage(1);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    eventOn(variable_events.VARIABLE_UPDATE_ENDED, async () => {
        entered.resolve();
        await release.promise;
    });
    const stop = initResponse();
    const handling = eventEmit(tavern_events.MESSAGE_RECEIVED, 1, 'normal');
    await entered.promise;
    stop();
    const temporary = jest
        .mocked(eventOn)
        .mock.calls.filter(
            ([event, listener]) =>
                event === tavern_events.CHARACTER_MESSAGE_RENDERED && listener !== renderObserver
        );
    expect(temporary).toHaveLength(1);
    expect(eventRemoveListener).toHaveBeenCalledWith(...temporary[0]);
    release.resolve();
    await handling;
    expect(renderObserver).not.toHaveBeenCalled();
    // 只有模拟宿主在接收前的一次格式化，不应对卸载后的界面再操作。
    expect(formatAsDisplayedMessage).toHaveBeenCalledTimes(1);
});

test('变量处理失败时释放临时渲染监听', async () => {
    mountMessage(1);
    const failure = new Error('variable listener failed');
    eventOn(variable_events.VARIABLE_UPDATE_ENDED, () => {
        throw failure;
    });
    await expect(onMessageReceived(1)).rejects.toBe(failure);
    const temporary = jest
        .mocked(eventOn)
        .mock.calls.filter(
            ([event, listener]) =>
                event === tavern_events.CHARACTER_MESSAGE_RENDERED && listener !== renderObserver
        );
    expect(temporary).toHaveLength(1);
    expect(eventRemoveListener).toHaveBeenCalledWith(...temporary[0]);
    expect(renderObserver).not.toHaveBeenCalled();
});
