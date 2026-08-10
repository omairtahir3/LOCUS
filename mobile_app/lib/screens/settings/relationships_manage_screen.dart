import 'package:flutter/material.dart';
import '../../theme/app_theme.dart';
import '../../services/api_service.dart';

class RelationshipsManageScreen extends StatefulWidget {
  const RelationshipsManageScreen({super.key});

  @override
  State<RelationshipsManageScreen> createState() => _RelationshipsManageScreenState();
}

class _RelationshipsManageScreenState extends State<RelationshipsManageScreen> {
  bool _isLoading = true;
  List<dynamic> _relationships = [];
  String _search = '';
  
  bool _isMerging = false;
  String _sourceId = '';
  String _targetId = '';
  bool _mergeLoading = false;

  @override
  void initState() {
    super.initState();
    _loadData();
  }

  Future<void> _loadData() async {
    setState(() => _isLoading = true);
    try {
      final res = await ApiService.getAllRelationships();
      if (res['statusCode'] == 200) {
        setState(() {
          _relationships = res['data'] ?? [];
        });
      }
    } catch (e) {
      debugPrint('Error loading relationships: $e');
    } finally {
      if (mounted) setState(() => _isLoading = false);
    }
  }

  Future<void> _handleMerge() async {
    if (_sourceId.isEmpty || _targetId.isEmpty || _sourceId == _targetId) {
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Please select two distinct relationships to merge.')));
      return;
    }

    setState(() => _mergeLoading = true);
    try {
      final res = await ApiService.mergeRelationships(sourceId: _sourceId, targetId: _targetId);
      if (res['statusCode'] == 200) {
        setState(() {
          _isMerging = false;
          _sourceId = '';
          _targetId = '';
        });
        await _loadData();
        if (mounted) ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Merged successfully.')));
      } else {
        throw Exception('Merge failed');
      }
    } catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('Merge failed: $e')));
    } finally {
      if (mounted) setState(() => _mergeLoading = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final filtered = _relationships.where((r) {
      final name = (r['person_name'] ?? '').toLowerCase();
      return name.contains(_search.toLowerCase());
    }).toList();

    return Scaffold(
      backgroundColor: AppColors.background,
      appBar: AppBar(
        title: const Text('Manage Relationships'),
        backgroundColor: Colors.transparent,
        elevation: 0,
      ),
      body: _isLoading
        ? const Center(child: CircularProgressIndicator())
        : Column(
            children: [
              Padding(
                padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 12),
                child: Row(
                  children: [
                    Expanded(
                      child: TextField(
                        onChanged: (v) => setState(() => _search = v),
                        decoration: InputDecoration(
                          hintText: 'Search names...',
                          prefixIcon: const Icon(Icons.search, size: 20),
                          contentPadding: const EdgeInsets.symmetric(vertical: 10),
                          border: OutlineInputBorder(borderRadius: BorderRadius.circular(14)),
                        ),
                      ),
                    ),
                    const SizedBox(width: 12),
                    ElevatedButton.icon(
                      onPressed: () => setState(() => _isMerging = !_isMerging),
                      icon: Icon(Icons.merge_type, size: 18, color: _isMerging ? Colors.black : Colors.white),
                      label: Text(_isMerging ? 'Cancel' : 'Merge', style: TextStyle(color: _isMerging ? Colors.black : Colors.white)),
                      style: ElevatedButton.styleFrom(
                        backgroundColor: _isMerging ? Colors.grey[300] : AppColors.primary,
                        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
                        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
                      ),
                    )
                  ],
                ),
              ),

              if (_isMerging)
                Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 8),
                  child: Container(
                    padding: const EdgeInsets.all(16),
                    decoration: BoxDecoration(
                      color: Colors.blue[50],
                      border: Border.all(color: Colors.blue[100]!),
                      borderRadius: BorderRadius.circular(12),
                    ),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        const Text('Merge Two Records', style: TextStyle(fontWeight: FontWeight.bold, color: Colors.blue)),
                        const SizedBox(height: 8),
                        const Text('Select a source record to delete, and a target record to keep.', style: TextStyle(fontSize: 12, color: Colors.black87)),
                        const SizedBox(height: 16),
                        
                        DropdownButtonFormField<String>(
                          value: _sourceId.isEmpty ? null : _sourceId,
                          decoration: InputDecoration(labelText: 'Source (Will be deleted)', border: OutlineInputBorder(borderRadius: BorderRadius.circular(8))),
                          items: _relationships.map<DropdownMenuItem<String>>((r) {
                            return DropdownMenuItem<String>(
                              value: r['_id'],
                              child: Text('${r['person_name']} - ${r['_id'].substring(r['_id'].length - 4)}'),
                            );
                          }).toList(),
                          onChanged: (v) => setState(() => _sourceId = v ?? ''),
                        ),
                        const SizedBox(height: 12),
                        DropdownButtonFormField<String>(
                          value: _targetId.isEmpty ? null : _targetId,
                          decoration: InputDecoration(labelText: 'Target (Will be kept)', border: OutlineInputBorder(borderRadius: BorderRadius.circular(8))),
                          items: _relationships.map<DropdownMenuItem<String>>((r) {
                            return DropdownMenuItem<String>(
                              value: r['_id'],
                              child: Text('${r['person_name']} - ${r['_id'].substring(r['_id'].length - 4)}'),
                            );
                          }).toList(),
                          onChanged: (v) => setState(() => _targetId = v ?? ''),
                        ),
                        const SizedBox(height: 16),
                        SizedBox(
                          width: double.infinity,
                          child: ElevatedButton(
                            onPressed: _mergeLoading ? null : _handleMerge,
                            style: ElevatedButton.styleFrom(backgroundColor: Colors.blue[600]),
                            child: _mergeLoading ? const SizedBox(height: 16, width: 16, child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white)) : const Text('Confirm Merge', style: TextStyle(color: Colors.white)),
                          ),
                        )
                      ],
                    ),
                  ),
                ),

              Expanded(
                child: ListView.builder(
                  padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 8),
                  itemCount: filtered.length,
                  itemBuilder: (context, index) {
                    final r = filtered[index];
                    final name = r['person_name'] ?? 'Unknown';
                    final relation = r['relationship_type'] ?? '';
                    final confirmedBy = r['confirmed_by'] ?? '';
                    final dt = r['createdAt'] != null ? DateTime.parse(r['createdAt']).toLocal() : DateTime.now();

                    return Card(
                      margin: const EdgeInsets.only(bottom: 12),
                      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
                      child: ListTile(
                        onTap: () {
                          Navigator.pushNamed(context, '/past-interactions', arguments: r['_id']);
                        },
                        leading: CircleAvatar(
                          backgroundColor: AppColors.primary.withOpacity(0.1),
                          child: Text(name.isNotEmpty ? name[0].toUpperCase() : '?', style: const TextStyle(color: AppColors.primary)),
                        ),
                        title: Text(name, style: const TextStyle(fontWeight: FontWeight.bold)),
                        subtitle: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            if (relation.isNotEmpty) Text('Relation: $relation', style: const TextStyle(fontSize: 12)),
                            Text('Confirmed by $confirmedBy on ${dt.month}/${dt.day}/${dt.year}', style: const TextStyle(fontSize: 12, color: AppColors.textMuted)),
                          ],
                        ),
                        trailing: Text('...${r['_id'].substring(r['_id'].length - 4)}', style: const TextStyle(fontSize: 10, color: AppColors.textMuted, fontFamily: 'monospace')),
                      ),
                    );
                  },
                ),
              ),
            ],
          ),
    );
  }
}
