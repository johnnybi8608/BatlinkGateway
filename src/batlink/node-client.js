export class NodeClient {
  constructor(config) {
    this.config = config;
  }

  async challenge() {
    const response = await fetch(`${this.config.nodeBaseUrl}/v1/auth/challenge`, {
      method: 'POST'
    });
    if (!response.ok) throw new Error(`node_challenge_${response.status}`);
    return response.json();
  }

  async verify({ pubkey, signature, challenge }) {
    const response = await fetch(`${this.config.nodeBaseUrl}/v1/auth/verify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pubkey, signature, challenge })
    });
    if (!response.ok) throw new Error(`node_verify_${response.status}:${await response.text()}`);
    return response.json();
  }

  async sendMessage(token, body) {
    const response = await fetch(`${this.config.nodeBaseUrl}/v1/message/send`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`
      },
      body: JSON.stringify(body)
    });
    if (!response.ok) throw new Error(`node_send_${response.status}:${await response.text()}`);
    return response.json().catch(() => ({}));
  }

  async pullMessages(token) {
    const response = await fetch(`${this.config.nodeBaseUrl}/v1/message/pull`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`
      },
      body: '{}'
    });
    if (!response.ok) throw new Error(`node_pull_${response.status}:${await response.text()}`);
    return response.json();
  }

  async ackBatch(token, messageIds) {
    const response = await fetch(`${this.config.nodeBaseUrl}/v1/message/ack/batch`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`
      },
      body: JSON.stringify({ message_ids: messageIds })
    });
    if (!response.ok) throw new Error(`node_ack_${response.status}:${await response.text()}`);
  }
}
