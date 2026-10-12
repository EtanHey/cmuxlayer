    # BEGIN cmux-resource-guard packaging
    system ENV.cc, "-Wall", "-Wextra", "-Werror",
           "-DGUARD_NODE=#{(formula_opt_bin("node")/"node").to_s.dump}",
           "-DGUARD_PATH=#{[formula_opt_bin("node"), formula_opt_bin("jq"), HOMEBREW_PREFIX/"bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(":").dump}",
           "-DGUARD_ENTRY=#{(libexec/"dist/resource-guard.js").to_s.dump}",
           "launchd/resource-guard/cmux-resource-guard.c", "-o", "cmux-resource-guard"
    bin.install "cmux-resource-guard"
    libexec.install "launchd", "scripts"
    # END cmux-resource-guard packaging
