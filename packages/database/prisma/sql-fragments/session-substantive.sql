COALESCE(sd.turns, 0) > 0
OR sd.input_tokens > 0
OR sd.output_tokens > 0
OR sd.cache_read_tokens > 0
OR sd.cache_write_tokens > 0
OR sd.tool_use_count > 0
OR sd.component_invocation_count > 0
