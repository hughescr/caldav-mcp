#!/usr/bin/env bash
# Stand-in for aws, gh, bun and node in tests/setup-deployment.test.ts.
# The test copies this file to bin/aws, bin/gh, bin/bun and bin/node. It records every call
# (argv and stdin) under $STUB_STATE/calls and prints canned output. It never prints its own
# arguments or stdin, so a secret handed to it cannot reach the script's output.
# Behaviour is switched by files the test creates in $STUB_STATE.
set -u

tool=${0##*/}
state=$STUB_STATE
mkdir -p "$state/calls"
n=$(( $(cat "$state/counter" 2>/dev/null || echo 0) + 1 ))
echo "$n" > "$state/counter"
printf '%s\0' "$tool" "$@" > "$state/calls/$n.argv"
printf 'AWS_REGION=%s\nSTACK_NAME=%s\n' "${AWS_REGION:-}" "${STACK_NAME:-}" > "$state/calls/$n.env"
if [[ -t 0 ]]; then : > "$state/calls/$n.stdin"; else cat > "$state/calls/$n.stdin"; fi

flag() { [[ -e "$state/$1" ]]; }

arg_after() { # option, then the call's own arguments
    local option=$1 previous=''
    shift
    for arg in "$@"; do
        [[ $previous == "$option" ]] && { printf '%s' "$arg"; return; }
        previous=$arg
    done
}

lines_of() { [[ -e "$state/$1" ]] && cat "$state/$1"; return 0; }

case "$tool:${1:-}:${2:-}" in
    aws:sts:get-caller-identity)
        if flag aws-logged-out; then echo 'Unable to locate credentials' >&2; exit 255; fi
        echo '{"UserId":"AIDAEXAMPLE","Account":"123456789012","Arn":"arn:aws:iam::123456789012:user/owner"}' ;;
    aws:cloudformation:describe-stacks)
        stack=$(arg_after --stack-name "$@")
        if flag describe-denied; then
            echo 'An error occurred (AccessDenied) when calling the DescribeStacks operation: not authorized' >&2
            exit 254
        fi
        if ! flag "stack.$stack"; then
            echo "An error occurred (ValidationError) when calling the DescribeStacks operation: Stack with id $stack does not exist" >&2
            exit 254
        fi
        query=$(arg_after --query "$@")
        # A JMESPath query that matches nothing prints None with --output text.
        if [[ $query == *OutputKey* ]] && flag no-outputs; then echo None; exit 0; fi
        case "$query" in
            *"'GitHubDeployRoleArn'"*) echo 'arn:aws:iam::123456789012:role/caldav-mcp-github-deploy' ;;
            *"'ArtifactBucketName'"*) echo 'caldav-mcp-bootstrap-artifactbucket-1a2b3c4d5e6f' ;;
            *"'ExecutionRoleArn'"*) echo 'arn:aws:iam::123456789012:role/caldav-mcp-prod-execution' ;;
            *"'ApiLambdaFunctionUrl'"*) if [[ -e "$state/function-url" ]]; then cat "$state/function-url"; echo; else echo None; fi ;;
            *) echo CREATE_COMPLETE ;;
        esac ;;
    aws:cloudformation:deploy)
        if flag deploy-fails; then echo 'Failed to create/update the stack' >&2; exit 1; fi
        : > "$state/stack.$(arg_after --stack-name "$@")" # the stack exists from now on
        echo 'Successfully created/updated stack' ;;
    gh:auth:status)
        if flag gh-logged-out; then echo 'You are not logged into any GitHub hosts.' >&2; exit 1; fi
        echo 'Logged in to github.com' ;;
    gh:variable:list) lines_of variables ;;
    gh:secret:list) lines_of secrets ;;
    gh:variable:set | gh:secret:set) ;;
    bun:scripts/provision-auth-keyring.ts:) echo '{"name":"/caldav-mcp/prod/auth-keyring","state":"created"}' ;;
    node:scripts/verify-deployment.mjs:) echo 'Deployment verified' ;;
    *) echo "stub $tool: unexpected call" >&2; exit 99 ;;
esac
