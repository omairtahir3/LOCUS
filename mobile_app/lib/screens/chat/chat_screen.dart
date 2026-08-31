import 'package:flutter/material.dart';
import '../../theme/app_theme.dart';
import '../../services/api_service.dart';
import '../../services/socket_service.dart';
import '../../services/selected_user_service.dart';

class ChatScreen extends StatefulWidget {
  final String? recipientId;
  final String? recipientName;
  final bool isEmergency;

  const ChatScreen({
    super.key,
    this.recipientId,
    this.recipientName,
    this.isEmergency = false,
  });

  @override
  State<ChatScreen> createState() => _ChatScreenState();
}

class _ChatScreenState extends State<ChatScreen> {
  final TextEditingController _msgCtrl = TextEditingController();
  final ScrollController _scrollCtrl = ScrollController();
  List<Map<String, dynamic>> _messages = [];
  bool _loading = true;

  String get activeRecipientId {
    // EXPLICIT REQUIREMENT: SOS always targets the triggered user. 
    // Manual chat defaults to globally selected user if no specific recipient is provided.
    if (widget.isEmergency && widget.recipientId != null) return widget.recipientId!;
    return widget.recipientId ?? SelectedUserService().selectedUser?['_id'] ?? '';
  }

  String get activeRecipientName {
    if (widget.isEmergency && widget.recipientName != null) return widget.recipientName!;
    return widget.recipientName ?? SelectedUserService().selectedUser?['name'] ?? 'Caregiver';
  }

  @override
  void initState() {
    super.initState();
    _loadHistory();
    SocketService().socket?.on('chat_message', _onNewMessage);
  }

  @override
  void dispose() {
    SocketService().socket?.off('chat_message');
    _msgCtrl.dispose();
    _scrollCtrl.dispose();
    super.dispose();
  }

  void _onNewMessage(dynamic data) {
    if (data == null) return;
    if (data is List && data.isNotEmpty) data = data.first;
    if (data is! Map) return;

    if (mounted) {
      final msgSender = data['sender_id']?.toString() ?? '';
      final msgRecipient = data['recipient_id']?.toString() ?? '';
      
      // Only append if it belongs to the active conversation
      if (msgSender == activeRecipientId || msgRecipient == activeRecipientId) {
        setState(() {
          _messages.add({
            '_id': data['_id']?.toString(),
            'sender_id': msgSender,
            'recipient_id': msgRecipient,
            'text': data['text']?.toString() ?? '',
            'timestamp': data['timestamp']?.toString(),
          });
        });
        _scrollToBottom();
      }
    }
  }

  Future<void> _loadHistory() async {
    try {
      final history = await ApiService.getChatHistory(activeRecipientId);
      if (mounted) {
        setState(() {
          _messages = history.map((e) => Map<String, dynamic>.from(e)).toList();
          _loading = false;
        });
        _scrollToBottom();
      }
    } catch (e) {
      if (mounted) {
        setState(() => _loading = false);
      }
    }
  }

  void _scrollToBottom() {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (_scrollCtrl.hasClients) {
        _scrollCtrl.animateTo(
          _scrollCtrl.position.maxScrollExtent,
          duration: const Duration(milliseconds: 300),
          curve: Curves.easeOut,
        );
      }
    });
  }

  void _sendMessage() {
    final text = _msgCtrl.text.trim();
    if (text.isEmpty || activeRecipientId.isEmpty) return;

    SocketService().socket?.emit('chat_message', {
      'recipient_id': activeRecipientId,
      'text': text,
      'is_emergency_related': widget.isEmergency,
    });

    _msgCtrl.clear();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(activeRecipientName, style: const TextStyle(fontWeight: FontWeight.w700, fontSize: 18)),
            if (widget.isEmergency)
              const Text('Emergency Active', style: TextStyle(color: AppColors.danger, fontSize: 12, fontWeight: FontWeight.w800)),
          ],
        ),
        backgroundColor: AppColors.surface,
        elevation: 1,
      ),
      backgroundColor: AppColors.background,
      body: Column(
        children: [
          Expanded(
            child: _loading
                ? const Center(child: CircularProgressIndicator())
                : ListView.builder(
                    controller: _scrollCtrl,
                    padding: const EdgeInsets.all(16),
                    itemCount: _messages.length,
                    itemBuilder: (context, i) {
                      final msg = _messages[i];
                      final isMe = msg['sender_id']?.toString() == ApiService.user?['_id']?.toString();
                      return _buildBubble(msg['text'], isMe, msg['timestamp']);
                    },
                  ),
          ),
          _buildInputArea(),
        ],
      ),
    );
  }

  Widget _buildBubble(dynamic rawText, bool isMe, dynamic rawTimestamp) {
    try {
      final text = rawText?.toString() ?? '';
      final timestamp = rawTimestamp?.toString();
      
      return Align(
        alignment: isMe ? Alignment.centerRight : Alignment.centerLeft,
        child: Container(
        margin: const EdgeInsets.only(bottom: 12, left: 16, right: 16),
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
        decoration: BoxDecoration(
          color: isMe ? AppColors.primary : AppColors.surface,
          borderRadius: BorderRadius.only(
            topLeft: const Radius.circular(16),
            topRight: const Radius.circular(16),
            bottomLeft: Radius.circular(isMe ? 16 : 4),
            bottomRight: Radius.circular(isMe ? 4 : 16),
          ),
          border: isMe ? null : Border.all(color: AppColors.border),
          boxShadow: [
            if (isMe) BoxShadow(color: AppColors.primary.withAlpha(50), blurRadius: 8, offset: const Offset(0, 4)),
          ],
        ),
        child: Column(
          crossAxisAlignment: isMe ? CrossAxisAlignment.end : CrossAxisAlignment.start,
          children: [
            Text(
              text,
              style: TextStyle(
                color: isMe ? Colors.white : AppColors.textPrimary,
                fontSize: 15,
              ),
            ),
            const SizedBox(height: 4),
            // Placeholder for status icons (read receipts)
            Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                Text(
                  _formatTime(timestamp),
                  style: TextStyle(
                    color: isMe ? Colors.white70 : AppColors.textMuted,
                    fontSize: 10,
                  ),
                ),
              ],
            )
          ],
        ),
      ),
    );
    } catch (e) {
      return Align(
        alignment: Alignment.center,
        child: Container(
          margin: const EdgeInsets.only(bottom: 12),
          padding: const EdgeInsets.all(8),
          color: Colors.red.shade100,
          child: const Text('Error loading message', style: TextStyle(color: Colors.red, fontSize: 12)),
        ),
      );
    }
  }

  String _formatTime(String? isoDate) {
    if (isoDate == null) return '';
    try {
      final dt = DateTime.parse(isoDate).toLocal();
      final h = dt.hour > 12 ? dt.hour - 12 : (dt.hour == 0 ? 12 : dt.hour);
      final m = dt.minute.toString().padLeft(2, '0');
      final ampm = dt.hour >= 12 ? 'PM' : 'AM';
      return '$h:$m $ampm';
    } catch (_) {
      return '';
    }
  }

  Widget _buildInputArea() {
    return Container(
      padding: const EdgeInsets.all(16).copyWith(bottom: 16 + MediaQuery.of(context).padding.bottom),
      decoration: BoxDecoration(
        color: AppColors.surface,
        border: Border(top: BorderSide(color: AppColors.border)),
      ),
      child: Row(
        children: [
          // Future placeholder for media attachments
          IconButton(
            icon: const Icon(Icons.add_circle_outline, color: AppColors.primary),
            onPressed: () {},
          ),
          Expanded(
            child: TextField(
              controller: _msgCtrl,
              decoration: InputDecoration(
                hintText: 'Type a message...',
                border: OutlineInputBorder(borderRadius: BorderRadius.circular(24), borderSide: BorderSide.none),
                filled: true,
                fillColor: AppColors.background,
                contentPadding: const EdgeInsets.symmetric(horizontal: 20, vertical: 12),
              ),
              textInputAction: TextInputAction.send,
              onSubmitted: (_) => _sendMessage(),
            ),
          ),
          const SizedBox(width: 8),
          CircleAvatar(
            backgroundColor: AppColors.primary,
            radius: 22,
            child: IconButton(
              icon: const Icon(Icons.send, color: Colors.white, size: 18),
              onPressed: _sendMessage,
            ),
          )
        ],
      ),
    );
  }
}
