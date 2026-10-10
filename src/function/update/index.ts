import { onMessageReceived } from '@/function/update/on_message_received';
import { clearPiRequestControllers } from '@/function/update/pi/controller_registry';
import { handleVariablesInMessage } from '@/function/update_variables';
import { is_jest_environment } from '@/jest';
import { useDataStore } from '@/store';
import { controlledStoppableEventOn } from '@/util';

/**
 * 注册消息接收和变量处理监听，并返回卸载函数。
 * 卸载时先取消 Pi 请求及提示词捕获，再移除监听，避免并发完成的捕获重新发起请求。
 */
export function initResponse() {
    const store = useDataStore();
    const controller = new AbortController();
    const receive = (message_id: number) =>
        onMessageReceived(message_id, { signal: controller.signal });
    const throttled_receive = _.throttle(receive, 3000);
    const stop_list: Array<() => void> = [];
    stop_list.push(
        controlledStoppableEventOn(tavern_events.MESSAGE_SENT, handleVariablesInMessage)
    );
    stop_list.push(
        controlledStoppableEventOn(tavern_events.MESSAGE_RECEIVED, message_id => {
            // 随 AI 输出必须让宿主等待本楼变量写入，再发出唯一的渲染通知。
            // throttle 的 trailing 调用不属于原接收事件，可能在宿主已经渲染后才运行。
            if (store.effective_settings.更新方式 === '随AI输出') {
                throttled_receive.cancel();
                return receive(message_id);
            }
            return is_jest_environment ? receive(message_id) : throttled_receive(message_id);
        })
    );
    return () => {
        controller.abort();
        throttled_receive.cancel();
        // Tombstone active capture attempts before tearing down response listeners. A capture
        // that settles concurrently must not be able to register a fresh Pi provider request.
        clearPiRequestControllers();
        stop_list.forEach(stop => stop());
    };
}
