// HexForge Ghidra post-script (headless): dumps every function - decompiled
// C, xrefs, call targets - as one JSON document. Runs inside Ghidra's
// GhidraScript runtime (plain Java, no Python dependency since Ghidra 12
// dropped Jython; a .java script compiles on the fly, no build step).
// The agent sets GHIDRA_REPORT, GHIDRA_MAX_DECOMPILE, GHIDRA_MAX_FUNCTIONS.
//@category Analysis

import java.io.File;
import java.io.FileWriter;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import ghidra.app.script.GhidraScript;
import ghidra.app.decompiler.DecompInterface;
import ghidra.app.decompiler.DecompileResults;
import ghidra.program.model.listing.Function;
import ghidra.program.model.listing.FunctionIterator;
import ghidra.program.model.address.Address;
import ghidra.program.model.symbol.Reference;
import ghidra.util.task.ConsoleTaskMonitor;

public class hexforge_dump extends GhidraScript {

	@Override
	public void run() throws Exception {
		String reportPath = System.getenv("GHIDRA_REPORT");
		if (reportPath == null || reportPath.isEmpty()) {
			throw new RuntimeException("GHIDRA_REPORT not set");
		}
		int maxDecompile = Integer.parseInt(envOr("GHIDRA_MAX_DECOMPILE", "8000"));
		int maxFunctions = Integer.parseInt(envOr("GHIDRA_MAX_FUNCTIONS", "2000"));

		var fm = currentProgram.getFunctionManager();
		var rf = currentProgram.getReferenceManager();

		DecompInterface decompiler = new DecompInterface();
		decompiler.openProgram(currentProgram);

		List<Map<String, Object>> functions = new ArrayList<>();
		FunctionIterator it = fm.getFunctions(true);
		while (it.hasNext() && functions.size() < maxFunctions) {
			Function func = it.next();
			Map<String, Object> entry = new LinkedHashMap<>();
			entry.put("name", func.getName());
			entry.put("address", func.getEntryPoint().toString());
			entry.put("size", func.getBody().getNumAddresses());
			try {
				DecompileResults result = decompiler.decompileFunction(func, 30, monitor);
				if (result != null && result.decompileCompleted()) {
					String code = result.getDecompiledFunction().getC();
					entry.put("decompiled", code.substring(0, Math.min(code.length(), maxDecompile)));
					entry.put("decompileTruncated", code.length() > maxDecompile);
				}
			} catch (Exception e) {
				entry.put("decompileError", String.valueOf(e.getMessage()));
			}
			List<String> calls = new ArrayList<>();
			List<Map<String, String>> refs = new ArrayList<>();
			for (Address addr : func.getBody().getAddresses(true)) {
				for (Reference ref : rf.getReferencesFrom(addr)) {
					if (ref.getReferenceType().isCall()) {
						calls.add(ref.getToAddress().toString());
					} else {
						refs.add(Map.of("to", ref.getToAddress().toString(),
							"type", ref.getReferenceType().toString()));
					}
				}
			}
			entry.put("calls", calls.subList(0, Math.min(calls.size(), 400)));
			entry.put("references", refs.subList(0, Math.min(refs.size(), 400)));
			functions.add(entry);
		}
		decompiler.dispose();

		Map<String, Object> doc = new LinkedHashMap<>();
		doc.put("program", currentProgram.getName());
		doc.put("language", currentProgram.getLanguageID().toString());
		doc.put("functionCount", fm.getFunctionCount());
		doc.put("reported", functions.size());
		doc.put("functions", functions);

		File out = new File(reportPath);
		try (FileWriter w = new FileWriter(out, StandardCharsets.UTF_8)) {
			// Hand-rolled JSON: the shapes above are flat and escaping is
			// handled by jsonEscape(); pulling in Gson inside a script is
			// not worth the classpath guesswork.
			w.write(toJson(doc));
		}
		println("HEXFORGE_REPORT_WRITTEN " + reportPath);
	}

	private static String envOr(String key, String def) {
		String v = System.getenv(key);
		return v == null || v.isEmpty() ? def : v;
	}

	@SuppressWarnings("unchecked")
	private static String toJson(Object value) {
		if (value == null) return "null";
		if (value instanceof Number || value instanceof Boolean) return value.toString();
		if (value instanceof Map<?, ?> m) {
			StringBuilder sb = new StringBuilder("{");
			boolean first = true;
			for (var e : m.entrySet()) {
				if (!first) sb.append(',');
				first = false;
				sb.append(jsonEscape(String.valueOf(e.getKey()))).append(':')
					.append(toJson(e.getValue()));
			}
			return sb.append('}').toString();
		}
		if (value instanceof Iterable<?> list) {
			StringBuilder sb = new StringBuilder("[");
			boolean first = true;
			for (Object item : list) {
				if (!first) sb.append(',');
				first = false;
				sb.append(toJson(item));
			}
			return sb.append(']').toString();
		}
		return jsonEscape(String.valueOf(value));
	}

	private static String jsonEscape(String s) {
		StringBuilder sb = new StringBuilder("\"");
		for (int i = 0; i < s.length(); i++) {
			char c = s.charAt(i);
			switch (c) {
				case '"' -> sb.append("\\\"");
				case '\\' -> sb.append("\\\\");
				case '\n' -> sb.append("\\n");
				case '\r' -> sb.append("\\r");
				case '\t' -> sb.append("\\t");
				default -> {
					if (c < 0x20) sb.append(String.format("\\u%04x", (int) c));
					else sb.append(c);
				}
			}
		}
		return sb.append('"').toString();
	}
}
