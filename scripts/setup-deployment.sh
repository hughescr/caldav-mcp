#!/usr/bin/env bash
# One-time deployment setup for caldav-mcp, run by the repository owner on a machine where the
# aws CLI (v2) and gh are already logged in. See "Deployment and rollback" in README.md.
#
#   ALLOWED_APPLE_ID_HASHES='<hash>[,<hash>...]' bun run setup:deployment      stage 1, safe to re-run
#   bun run setup:deployment -- --enable-deploy                                 turn deployment on
#   bun run setup:deployment -- --finish                                        stage 2, after the first deploy
#
# --dry-run prints the commands that would change something and changes nothing.
# Secret values (the allowlist, SERVERLESS_ACCESS_KEY) go to gh on stdin and are never printed.
set -euo pipefail

# Plain ASCII character ranges in the regular expressions below, whatever the user's locale.
LC_ALL=C
# The verifier and every aws call use this region, whatever the owner's AWS profile says.
export AWS_REGION=us-west-2 AWS_DEFAULT_REGION=us-west-2 AWS_PAGER=''

REGION=us-west-2
REPO=hughescr/caldav-mcp
BOOTSTRAP_STACK=caldav-mcp-bootstrap
SERVICE_STACK=caldav-mcp-prod
PLACEHOLDER_ORIGIN=https://placeholder.lambda-url.us-west-2.on.aws
# One or more 43-character base64url hashes separated by single commas.
HASHES_RE='^[A-Za-z0-9_-]{43}(,[A-Za-z0-9_-]{43})*$'
# The AllowedPattern of the FunctionUrlOrigin parameter in infra/bootstrap.yml.
ORIGIN_RE='^https://[a-z0-9]+\.lambda-url\.[a-z0-9-]+\.on\.aws$'

die() { echo "Error: $*" >&2; exit 1; }
say() { echo "==> $*"; }

dry_run=false
finish=false
enable_deploy=false
bootstrap_exists=false
for arg in "$@"; do
    case $arg in
        --dry-run) dry_run=true ;;
        --finish) finish=true ;;
        --enable-deploy) enable_deploy=true ;;
        *) die 'Unknown argument. Usage: setup-deployment.sh [--dry-run] [--finish] [--enable-deploy]' ;;
    esac
done
if $finish && $enable_deploy; then die '--finish and --enable-deploy are separate stages; run them one at a time.'; fi

cd "$(dirname "$0")/.."

# Run a command that changes something, or only show it with --dry-run.
run() {
    if $dry_run; then
        printf '+'; printf ' %s' "$@"; printf '\n'
    else
        "$@"
    fi
}

# Like run, but sends a secret on stdin. The value is never shown.
run_with_secret() { # value command...
    local value=$1
    shift
    if $dry_run; then
        printf '+ printf %%s <hidden> |'; printf ' %s' "$@"; printf '\n'
    else
        printf '%s' "$value" | "$@"
    fi
}

need() { command -v "$1" >/dev/null 2>&1 || die "$1 is not installed or not on PATH."; }

check_prerequisites() {
    need aws
    need gh
    need bun
    if $finish; then need node; fi
    aws sts get-caller-identity --region "$REGION" >/dev/null 2>&1 || die "aws is not logged in: 'aws sts get-caller-identity' failed."
    gh auth status >/dev/null 2>&1 || die "gh is not logged in: 'gh auth status' failed."
}

# Succeeds if the stack exists, fails if it does not. Any other error (no permission, no network) stops the script.
stack_exists() {
    local errors
    if errors=$(aws cloudformation describe-stacks --region "$REGION" --stack-name "$1" \
        --query 'Stacks[0].StackStatus' --output text 2>&1 >/dev/null); then
        return 0
    fi
    [[ $errors == *'does not exist'* ]] && return 1
    die "Could not look up stack $1: ${errors%%$'\n'*}"
}

stack_output() { # stack output-key
    local value
    value=$(aws cloudformation describe-stacks --region "$REGION" --stack-name "$1" \
        --query "Stacks[0].Outputs[?OutputKey=='$2'].OutputValue | [0]" --output text) \
        || die "Could not read output $2 of stack $1."
    [[ -n $value && $value != None ]] || die "Stack $1 has no output $2."
    printf '%s' "$value"
}

# Extra arguments, if any, are added to the end of the command.
#
# Without --parameter-overrides for FunctionUrlOrigin, `aws cloudformation deploy` sends
# UsePreviousValue for it on an existing stack, so the stored value (the real Function URL
# after --finish) is kept. On a new stack it is required, so stage 1 passes the placeholder.
# `deploy` also waits until the stack create or update has finished.
deploy_bootstrap() {
    run aws cloudformation deploy --region "$REGION" --stack-name "$BOOTSTRAP_STACK" \
        --template-file infra/bootstrap.yml --capabilities CAPABILITY_NAMED_IAM "$@"
}

# True if the newline-separated list contains the name.
has_name() { [[ $'\n'$1$'\n' == *$'\n'"$2"$'\n'* ]]; }

list_names() { # variable|secret
    gh "$1" list --repo "$REPO" --json name --jq '.[].name' || die "Could not list repository ${1}s with gh."
}

# With --dry-run on a first run the stack is not there to read from, so show the output name instead.
set_output_variable() { # variable-name output-key
    local value
    if $dry_run && ! $bootstrap_exists; then value="<$2>"; else value=$(stack_output "$BOOTSTRAP_STACK" "$2"); fi
    run gh variable set "$1" --repo "$REPO" --body "$value"
}

stage_one() {
    local existing_variables existing_secrets

    # Check everything that can be wrong with the inputs before changing anything.
    existing_variables=$(list_names variable)
    existing_secrets=$(list_names secret)
    if [[ -n ${ALLOWED_APPLE_ID_HASHES:-} ]]; then
        [[ $ALLOWED_APPLE_ID_HASHES =~ $HASHES_RE ]] \
            || die 'ALLOWED_APPLE_ID_HASHES must be 43-character account hashes (from bun run apple-id-hash) separated by single commas, with no spaces.'
    elif ! has_name "$existing_variables" ALLOWED_APPLE_ID_HASHES; then
        die "ALLOWED_APPLE_ID_HASHES is not set and $REPO has no such variable. Run: ALLOWED_APPLE_ID_HASHES='<hash>[,<hash>...]' bun run setup:deployment"
    fi
    if ! has_name "$existing_secrets" SERVERLESS_ACCESS_KEY && [[ -z ${SERVERLESS_ACCESS_KEY:-} && ! -t 0 ]]; then
        die 'SERVERLESS_ACCESS_KEY is not a repository secret yet. Export SERVERLESS_ACCESS_KEY, or run this from a terminal so gh can ask for it.'
    fi

    say "Bootstrap stack $BOOTSTRAP_STACK"
    if stack_exists "$BOOTSTRAP_STACK"; then
        bootstrap_exists=true
        deploy_bootstrap
    else
        deploy_bootstrap --parameter-overrides "FunctionUrlOrigin=$PLACEHOLDER_ORIGIN"
    fi

    say 'Repository variables from the stack outputs'
    set_output_variable AWS_DEPLOY_ROLE_ARN GitHubDeployRoleArn
    set_output_variable AWS_DEPLOYMENT_BUCKET_NAME ArtifactBucketName
    set_output_variable AWS_EXECUTION_ROLE_ARN ExecutionRoleArn
    run gh variable set AUTH_KEYRING_PARAMETER --repo "$REPO" --body /caldav-mcp/prod/auth-keyring

    say 'Allowlist'
    if [[ -n ${ALLOWED_APPLE_ID_HASHES:-} ]]; then
        run_with_secret "$ALLOWED_APPLE_ID_HASHES" gh variable set ALLOWED_APPLE_ID_HASHES --repo "$REPO"
    else
        echo 'ALLOWED_APPLE_ID_HASHES is not set here; keeping the repository variable as it is.'
    fi

    say 'Keyring (never overwrites an existing one)'
    run bun scripts/provision-auth-keyring.ts

    say 'Secret SERVERLESS_ACCESS_KEY'
    if has_name "$existing_secrets" SERVERLESS_ACCESS_KEY; then
        echo 'Already set; keeping it.'
    elif [[ -n ${SERVERLESS_ACCESS_KEY:-} ]]; then
        run_with_secret "$SERVERLESS_ACCESS_KEY" gh secret set SERVERLESS_ACCESS_KEY --repo "$REPO"
    else
        run gh secret set SERVERLESS_ACCESS_KEY --repo "$REPO" # gh asks for the value without echoing it
    fi

    if $enable_deploy; then
        say 'Enabling deployment'
        run gh variable set DEPLOY_ENABLED --repo "$REPO" --body true
    else
        echo 'Deployment is still disabled. Re-run with --enable-deploy, then release to main.'
    fi
}

stage_two() {
    stack_exists "$SERVICE_STACK" \
        || die "Stack $SERVICE_STACK does not exist yet. Deploy from main first (--enable-deploy, then release), then run --finish."
    local origin
    origin=$(stack_output "$SERVICE_STACK" ApiLambdaFunctionUrl)
    origin=${origin%/}
    [[ $origin =~ $ORIGIN_RE ]] || die "The Function URL of $SERVICE_STACK is not a bare https://<id>.lambda-url.<region>.on.aws origin: $origin"

    say "Pointing $BOOTSTRAP_STACK at $origin"
    deploy_bootstrap --parameter-overrides "FunctionUrlOrigin=$origin"

    say 'Verifying the live deployment'
    run node scripts/verify-deployment.mjs
}

check_prerequisites
if $dry_run; then say 'Dry run: nothing is changed. Lines starting with + are what would run.'; fi
if $finish; then stage_two; else stage_one; fi
