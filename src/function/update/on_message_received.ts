import { isExtraModelSupported } from '@/function/is_extra_model_supported';
import { isFunctionCallingSupported } from '@/function/is_function_calling_supported';
import { invokeExtraModelWithStrategy } from '@/function/update/invoke_extra_model';
import { getPiRequestFailureToastMessage } from '@/function/update/pi/error_localization';
import { isPiMultiproviderEnabled } from '@/function/update/pi/feature_flag';
import { handleVariablesInMessage } from '@/function/update_variables';
import { tr } from '@/i18n';
import { useDataStore } from '@/store';

/**
 * 随 AI 输出时，宿主还会在 MESSAGE_RECEIVED 之后派发渲染事件。
 * 只同步正文 DOM，不提前触发助手的 iframe 渲染；流式宿主不会再次格式化正文，不能仅保存文本。
 * 如果宿主未等待接收处理（例如流式出错），则在变量写回后主动补一次必要的刷新。
 */
async function handleVariablesBeforeRender(
    message_id: number,
    isCurrentMessage: () => boolean,
    signal?: AbortSignal
) {
    let host_has_rendered = false;
    const onRendered = (rendered_message_id: number) => {
        if (rendered_message_id === message_id) host_has_rendered = true;
    };
    const stop = () => eventRemoveListener(tavern_events.CHARACTER_MESSAGE_RENDERED, onRendered);
    eventOn(tavern_events.CHARACTER_MESSAGE_RENDERED, onRendered);
    signal?.addEventListener('abort', stop, { once: true });
    try {
        await handleVariablesInMessage(message_id, {
            refresh: async () => {
                if (!isCurrentMessage()) return;
                if (host_has_rendered) {
                    await setChatMessages([{ message_id }], { refresh: 'affected' });
                    return;
                }
                const latest_message = getChatMessages(message_id).at(-1);
                const $message = retrieveDisplayedMessage(message_id);
                if (latest_message && $message.length > 0) {
                    $message
                        .empty()
                        .append(formatAsDisplayedMessage(latest_message.message, { message_id }));
                }
            },
        });
    } finally {
        stop();
        signal?.removeEventListener('abort', stop);
    }
}

/** 接收时启动解析；非工具调用的自动解析在本条消息渲染后等待结果并写回。 */
export async function onMessageReceived(
    message_id: number,
    { force = false, signal }: { force?: boolean; signal?: AbortSignal } = {}
) {
    if (signal?.aborted) {
        return;
    }
    const current_chatmsg = getChatMessages(message_id).at(-1);
    if (!current_chatmsg) {
        return;
    }

    const store = useDataStore();
    if (
        store.effective_settings.兼容性.sendas不视为user消息 === false &&
        current_chatmsg.name !== SillyTavern.name2
    ) {
        return;
    }

    const message_content = current_chatmsg.message;
    if (message_content.length < 5) {
        // MESSAGE_RECEIVED 有时候也会在请求的一开始递交，会包含一个 "..." 的消息。
        return;
    }

    // 每次调用独立捕获目标身份；内容变化或追加后续消息不使其失效。
    const chat_id = SillyTavern.getCurrentChatId();
    const chat_message = SillyTavern.chat[message_id];
    const swipe_id = chat_message?.swipe_id;
    const isCurrentMessage = () =>
        !signal?.aborted &&
        SillyTavern.getCurrentChatId() === chat_id &&
        SillyTavern.chat[message_id] === chat_message &&
        chat_message?.swipe_id === swipe_id;

    const follows_ai_output = store.effective_settings.更新方式 === '随AI输出';
    if (
        follows_ai_output ||
        (store.settings.额外模型解析配置.模型来源 === '更多' && !isPiMultiproviderEnabled()) ||
        (store.settings.额外模型解析配置.应答格式 === '工具调用' &&
            store.settings.额外模型解析配置.模型来源 !== '更多' &&
            !isFunctionCallingSupported()) ||
        !(await isExtraModelSupported())
    ) {
        if (isCurrentMessage()) {
            if (follows_ai_output && !force) {
                await handleVariablesBeforeRender(message_id, isCurrentMessage, signal);
            } else {
                await handleVariablesInMessage(message_id);
            }
        }
        return;
    }

    if (SillyTavern.chat.length <= 1) {
        console.log(tr('runtime.extraModel.firstFloorSkippedLog'));
        return;
    }

    if (!force && store.effective_settings.额外模型解析配置.启用自动请求 === false) {
        console.log(tr('runtime.extraModel.autoRequestDisabledLog'));
        return;
    }

    if (!isCurrentMessage()) {
        return;
    }

    // MESSAGE_RECEIVED 中立即发起请求。Promise 与目标快照均属于本次调用的闭包。
    const request_source = store.settings.额外模型解析配置.模型来源;
    const request_response_format = store.settings.额外模型解析配置.应答格式;
    const defer_until_rendered =
        !force &&
        request_response_format !== '工具调用' &&
        store.settings.兼容性.额外模型解析非阻塞;
    const result_promise = invokeExtraModelWithStrategy().catch(error => {
        // 错误提示描述实际发起的请求，避免等待期间面板切换导致错误归类失真。
        if (request_source === '更多') {
            toastr.error(
                getPiRequestFailureToastMessage(error, request_response_format),
                tr('runtime.extraModel.updateFailedTitle')
            );
        }
        throw error;
    });
    // 请求可能早于渲染失败；先登记拒绝处理，渲染回调仍从原 Promise 收到异常。
    void result_promise.catch(() => undefined);

    async function applyResult() {
        const result = await result_promise;
        if (!isCurrentMessage()) {
            return;
        }
        if (result !== null) {
            // 等待期间正文可能变化，拼接前重新读取，避免覆盖最新内容。
            const latest_message = getChatMessages(message_id).at(-1);
            if (!latest_message) {
                return;
            }
            const updated_content = latest_message.message.trimEnd() + '\n\n' + result;
            await setChatMessages([{ message_id, message: updated_content }], { refresh: 'none' });
        } else if (request_source !== '更多') {
            toastr.error(
                tr('runtime.extraModel.updateFailed'),
                tr('runtime.extraModel.updateFailedTitle')
            );
        }
        if (isCurrentMessage()) {
            await handleVariablesInMessage(message_id);
        }
    }

    if (!defer_until_rendered) {
        await applyResult();
        return;
    }
    // 不用 eventOnce：其他楼层的渲染不能消费本次监听。命中后先移除，避免变量写回
    // 以 refresh:'affected' 触发重入渲染；返回 Promise 让宿主在保存前等待写回完成。
    const onRendered = (rendered_message_id: number) => {
        if (!isCurrentMessage()) {
            stop();
            return;
        }
        if (rendered_message_id !== message_id) {
            return;
        }
        stop();
        return applyResult();
    };
    const stop = () => {
        eventRemoveListener(tavern_events.CHARACTER_MESSAGE_RENDERED, onRendered);
        signal?.removeEventListener('abort', stop);
    };
    eventOn(tavern_events.CHARACTER_MESSAGE_RENDERED, onRendered);
    // 聊天级模块卸载时清理尚未等到渲染的监听，也使在途请求的写回校验失效。
    signal?.addEventListener('abort', stop, { once: true });
}
