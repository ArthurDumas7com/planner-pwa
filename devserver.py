"""Локальный сервер для разработки и просмотра с телефона.

Слушает на всех интерфейсах (0.0.0.0), чтобы приложение открывалось с телефона
в той же Wi-Fi сети: http://<ip-компьютера>:8200
Кэширование отключено, чтобы правки подхватывались сразу.
"""
import socket
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

PORT = 8200


class NoCacheHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store, no-cache, must-revalidate')
        self.send_header('Pragma', 'no-cache')
        super().end_headers()

    def log_message(self, fmt, *args):        # тише в консоли
        pass


def local_ip():
    """IP компьютера в локальной сети (наружу ничего не отправляется)."""
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(('10.255.255.255', 1))
        return s.getsockname()[0]
    except Exception:
        return '127.0.0.1'
    finally:
        s.close()


if __name__ == '__main__':
    print(f'  На компьютере:  http://127.0.0.1:{PORT}')
    print(f'  С телефона:     http://{local_ip()}:{PORT}')
    print('  (телефон и компьютер должны быть в одной Wi-Fi сети)')
    ThreadingHTTPServer(('0.0.0.0', PORT), NoCacheHandler).serve_forever()
