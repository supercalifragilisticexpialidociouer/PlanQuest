import com.planquest.app.LanTcp;

import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

/**
 * 桌面 JVM 上验证兰局域房间协议（与手机上跑的 LanTcp 是同一份代码）。
 * 用法：java RoomProbe <ip> <port> <房间码>
 */
public class RoomProbe {

    static LanTcp conn;

    public static void main(String[] args) throws Exception {
        String host = args[0];
        int port = Integer.parseInt(args[1]);
        String code = args[2];

        System.out.println("== 1. probe ==");
        String info = LanTcp.request(host, port, "{\"type\":\"probe\",\"code\":\"" + code + "\"}", 3500);
        System.out.println("PROBE => " + info);
        if (info == null) {
            System.out.println("FAIL 探测没拿到响应");
            return;
        }

        System.out.println("== 2. join ==");
        conn = new LanTcp();
        conn.open(host, port, 4000);
        final CountDownLatch welcomed = new CountDownLatch(1);
        conn.startReader(new LanTcp.Listener() {
            @Override
            public void onLine(String line) {
                String show = line.length() > 200 ? line.substring(0, 200) + "…(" + line.length() + " 字节)" : line;
                System.out.println("LINE => " + show);
                if (line.contains("\"welcome\"")) welcomed.countDown();
            }

            @Override
            public void onClosed(String reason) {
                System.out.println("CLOSED => " + reason);
            }
        });
        conn.write("{\"type\":\"join\",\"code\":\"" + code + "\",\"name\":\"手机测试\",\"avatar\":\"📱\"}");
        boolean ok = welcomed.await(5, TimeUnit.SECONDS);
        System.out.println("WELCOME => " + (ok ? "收到" : "超时"));

        System.out.println("== 3. 发聊天 / 番茄钟状态 / 表情 ==");
        conn.write("{\"type\":\"chat\",\"text\":\"来自 Java 客户端的问候\"}");
        conn.write("{\"type\":\"state\",\"state\":{\"task\":\"写作业\",\"min\":25}}");
        conn.write("{\"type\":\"reaction\",\"emoji\":\"👍\"}");
        Thread.sleep(1200);

        System.out.println("== 4. 错误房间码应被拒绝 ==");
        String bad = LanTcp.request(host, port, "{\"type\":\"probe\",\"code\":\"0000\"}", 3500);
        System.out.println("BADCODE => " + bad);

        conn.write("{\"type\":\"bye\"}");
        conn.close();
        Thread.sleep(300);
        System.out.println("DONE");
    }
}
