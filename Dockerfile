FROM python:3.13-slim
WORKDIR /app
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY server.py assistant_chat.py wallet_auth.py github_repos.py ./
COPY public/ public/
COPY integrations/telegram.py integrations/telegram.py
RUN mkdir -p /app/data && chown 10001:10001 /app/data
USER 10001:10001
EXPOSE 8787
CMD ["python", "server.py", "--host", "0.0.0.0"]
