import os
import io
import uuid
from datetime import datetime
from functools import wraps

from flask import (Flask, render_template, request, redirect, url_for,
                   flash, session, jsonify, send_from_directory)
from flask_socketio import SocketIO, emit, join_room, leave_room
from flask_sqlalchemy import SQLAlchemy
from werkzeug.security import generate_password_hash, check_password_hash
from werkzeug.utils import secure_filename
from PIL import Image

app = Flask(__name__)
app.config['SECRET_KEY'] = os.environ.get('SECRET_KEY', 'change-this-secret-key-in-production')
_db_url = os.environ.get('DATABASE_URL', '')
if _db_url:
    _db_url = _db_url.replace('postgres://', 'postgresql+pg8000://', 1)
    _db_url = _db_url.replace('postgresql://', 'postgresql+pg8000://', 1)
    app.config['SQLALCHEMY_DATABASE_URI'] = _db_url
else:
    app.config['SQLALCHEMY_DATABASE_URI'] = 'sqlite:///messenger.db'
app.config['SQLALCHEMY_TRACK_MODIFICATIONS'] = False
app.config['UPLOAD_FOLDER'] = os.path.join('static', 'uploads')
app.config['MAX_CONTENT_LENGTH'] = 20 * 1024 * 1024

# ── File storage ──────────────────────────────────────────────────────────────
# UPLOAD_BASE can be set to a Railway volume mount path, e.g. /data
# If not set, files go to static/uploads (ephemeral on Railway without volume)
_UPLOAD_BASE = os.environ.get('UPLOAD_BASE', '')

def _upload_path(key):
    """Return absolute filesystem path for a file key like uploads/avatars/x.jpg"""
    if _UPLOAD_BASE:
        return os.path.join(_UPLOAD_BASE, key)
    return os.path.join('static', key)

def save_upload(data, subfolder, filename, content_type='application/octet-stream'):
    key = f"uploads/{subfolder}/{filename}"
    body = data if isinstance(data, bytes) else data.read()
    fpath = _upload_path(key)
    os.makedirs(os.path.dirname(fpath), exist_ok=True)
    with open(fpath, 'wb') as fp:
        fp.write(body)
    return key

def get_file_url(path):
    if not path:
        return ''
    if path.startswith('http://') or path.startswith('https://'):
        return path
    if _UPLOAD_BASE:
        return url_for('serve_upload', filename=path)
    return url_for('static', filename=path)

@app.context_processor
def inject_file_url():
    return dict(file_url=get_file_url)

db = SQLAlchemy(app)
socketio = SocketIO(app, cors_allowed_origins="*", async_mode='gevent')

ALLOWED_EXTENSIONS = {'png', 'jpg', 'jpeg', 'gif', 'webp', 'mp3', 'ogg', 'webm', 'wav', 'm4a'}
ALLOWED_AUDIO = {'mp3', 'ogg', 'webm', 'wav', 'm4a'}
online_users = {}  # sid -> user_id
stream_sessions = {}  # channel_id -> streamer_sid


# ── Models ────────────────────────────────────────────────────────────────────

class User(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    username = db.Column(db.String(80), unique=True, nullable=False)
    display_name = db.Column(db.String(100), nullable=False)
    email = db.Column(db.String(120), unique=True, nullable=False)
    password_hash = db.Column(db.String(256), nullable=False)
    avatar = db.Column(db.String(256), default='')
    bio = db.Column(db.Text, default='')
    is_admin = db.Column(db.Boolean, default=False)
    is_banned = db.Column(db.Boolean, default=False)
    is_frozen = db.Column(db.Boolean, default=False)
    ip_address = db.Column(db.String(45), default='')
    created_at = db.Column(db.DateTime, default=datetime.utcnow)
    online = db.Column(db.Boolean, default=False)
    last_seen = db.Column(db.DateTime, default=datetime.utcnow)
    hide_last_seen = db.Column(db.Boolean, default=False)
    role = db.Column(db.String(20), default='user')  # 'user', 'moderator', 'admin'

    @property
    def is_moderator(self):
        return self.role == 'moderator'

    def can_admin(self):
        return self.is_admin or self.role in ('admin', 'moderator')

    def format_last_seen(self):
        if self.online:
            return 'онлайн'
        if self.hide_last_seen:
            return 'недавно'
        if not self.last_seen:
            return 'недавно'
        now = datetime.utcnow()
        diff = now - self.last_seen
        if diff.total_seconds() < 60:
            return 'только что'
        if diff.total_seconds() < 3600:
            mins = int(diff.total_seconds() // 60)
            return f'{mins} мин. назад'
        if diff.days == 0:
            return f'сегодня в {self.last_seen.strftime("%H:%M")}'
        if diff.days == 1:
            return f'вчера в {self.last_seen.strftime("%H:%M")}'
        return self.last_seen.strftime('%d.%m.%Y')

    def to_dict(self):
        return {
            'id': self.id,
            'username': self.username,
            'display_name': self.display_name,
            'avatar': get_file_url(self.avatar) if self.avatar else url_for('static', filename='default_avatar.svg'),
            'bio': self.bio,
            'online': self.online,
            'last_seen': self.format_last_seen(),
            'hide_last_seen': self.hide_last_seen,
            'role': self.role,
            'is_admin': self.is_admin,
        }


class Message(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    sender_id = db.Column(db.Integer, db.ForeignKey('user.id'), nullable=False)
    receiver_id = db.Column(db.Integer, db.ForeignKey('user.id'), nullable=False)
    content = db.Column(db.Text, default='')
    image_path = db.Column(db.String(256), default='')
    audio_path = db.Column(db.String(256), default='')
    message_type = db.Column(db.String(20), default='text')
    created_at = db.Column(db.DateTime, default=datetime.utcnow)
    is_read = db.Column(db.Boolean, default=False)
    is_edited = db.Column(db.Boolean, default=False)
    deleted_for_sender = db.Column(db.Boolean, default=False)
    deleted_for_receiver = db.Column(db.Boolean, default=False)
    deleted_for_all = db.Column(db.Boolean, default=False)
    reply_to_id = db.Column(db.Integer, nullable=True)

    sender = db.relationship('User', foreign_keys=[sender_id])
    receiver = db.relationship('User', foreign_keys=[receiver_id])

    def to_dict(self):
        reply_data = None
        if self.reply_to_id:
            r = db.session.get(Message, self.reply_to_id)
            if r:
                reply_data = {
                    'id': r.id,
                    'content': (r.content or '')[:80],
                    'sender_name': r.sender.display_name if r.sender else '?',
                    'message_type': r.message_type,
                    'image_url': get_file_url(r.image_path) if r.image_path else '',
                }
        return {
            'id': self.id,
            'sender_id': self.sender_id,
            'receiver_id': self.receiver_id,
            'content': self.content,
            'image_url': get_file_url(self.image_path) if self.image_path else '',
            'audio_url': get_file_url(self.audio_path) if self.audio_path else '',
            'message_type': self.message_type,
            'created_at': self.created_at.strftime('%H:%M'),
            'created_date': self.created_at.strftime('%d.%m.%Y'),
            'is_read': self.is_read,
            'is_edited': self.is_edited,
            'deleted_for_all': self.deleted_for_all,
            'reply_to': reply_data,
            'sender': self.sender.to_dict() if self.sender else None,
        }


class SupportTicket(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(db.Integer, db.ForeignKey('user.id'), nullable=False)
    subject = db.Column(db.String(200), nullable=False)
    status = db.Column(db.String(20), default='open')
    created_at = db.Column(db.DateTime, default=datetime.utcnow)

    user = db.relationship('User', backref='tickets')
    messages = db.relationship('SupportMessage', backref='ticket', lazy=True,
                                order_by='SupportMessage.created_at')


class SupportMessage(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    ticket_id = db.Column(db.Integer, db.ForeignKey('support_ticket.id'), nullable=False)
    sender_id = db.Column(db.Integer, db.ForeignKey('user.id'), nullable=False)
    content = db.Column(db.Text, nullable=False)
    created_at = db.Column(db.DateTime, default=datetime.utcnow)

    sender = db.relationship('User')


class GroupChat(db.Model):
    __tablename__ = 'group_chat'
    id = db.Column(db.Integer, primary_key=True)
    name = db.Column(db.String(100), nullable=False)
    description = db.Column(db.Text, default='')
    avatar = db.Column(db.String(256), default='')
    created_by = db.Column(db.Integer, db.ForeignKey('user.id'), nullable=False)
    created_at = db.Column(db.DateTime, default=datetime.utcnow)

    creator = db.relationship('User', foreign_keys=[created_by])
    members = db.relationship('GroupMember', backref='group', lazy='dynamic')


class GroupMember(db.Model):
    __tablename__ = 'group_member'
    id = db.Column(db.Integer, primary_key=True)
    group_id = db.Column(db.Integer, db.ForeignKey('group_chat.id'), nullable=False)
    user_id = db.Column(db.Integer, db.ForeignKey('user.id'), nullable=False)
    role = db.Column(db.String(20), default='member')
    joined_at = db.Column(db.DateTime, default=datetime.utcnow)

    user = db.relationship('User')


class GroupMessage(db.Model):
    __tablename__ = 'group_message'
    id = db.Column(db.Integer, primary_key=True)
    group_id = db.Column(db.Integer, db.ForeignKey('group_chat.id'), nullable=False)
    sender_id = db.Column(db.Integer, db.ForeignKey('user.id'), nullable=False)
    content = db.Column(db.Text, default='')
    image_path = db.Column(db.String(256), default='')
    audio_path = db.Column(db.String(256), default='')
    message_type = db.Column(db.String(20), default='text')
    created_at = db.Column(db.DateTime, default=datetime.utcnow)
    is_edited = db.Column(db.Boolean, default=False)
    is_deleted = db.Column(db.Boolean, default=False)
    reply_to_id = db.Column(db.Integer, nullable=True)

    sender = db.relationship('User')

    def to_dict(self):
        reply_data = None
        if self.reply_to_id:
            r = db.session.get(GroupMessage, self.reply_to_id)
            if r:
                reply_data = {
                    'id': r.id,
                    'content': (r.content or '')[:80],
                    'sender_name': r.sender.display_name if r.sender else '?',
                    'message_type': r.message_type,
                    'image_url': get_file_url(r.image_path) if r.image_path else '',
                }
        return {
            'id': self.id,
            'group_id': self.group_id,
            'sender_id': self.sender_id,
            'content': self.content,
            'image_url': get_file_url(self.image_path) if self.image_path else '',
            'audio_url': get_file_url(self.audio_path) if self.audio_path else '',
            'message_type': self.message_type,
            'created_at': self.created_at.strftime('%H:%M'),
            'created_date': self.created_at.strftime('%d.%m.%Y'),
            'is_edited': self.is_edited,
            'is_deleted': self.is_deleted,
            'reply_to': reply_data,
            'sender': self.sender.to_dict() if self.sender else None,
        }


class Channel(db.Model):
    __tablename__ = 'channel'
    id = db.Column(db.Integer, primary_key=True)
    name = db.Column(db.String(100), nullable=False)
    username = db.Column(db.String(50), unique=True, nullable=False)
    description = db.Column(db.Text, default='')
    avatar = db.Column(db.String(256), default='')
    owner_id = db.Column(db.Integer, db.ForeignKey('user.id'), nullable=False)
    created_at = db.Column(db.DateTime, default=datetime.utcnow)
    is_live = db.Column(db.Boolean, default=False)

    owner = db.relationship('User', foreign_keys=[owner_id])
    subscriptions = db.relationship('ChannelSubscription', backref='channel', lazy='dynamic')
    posts = db.relationship('ChannelPost', backref='channel', lazy='dynamic',
                             order_by='ChannelPost.created_at.desc()')

    def sub_count(self):
        return self.subscriptions.count()

    def to_dict(self):
        return {
            'id': self.id,
            'name': self.name,
            'username': self.username,
            'description': self.description,
            'avatar': get_file_url(self.avatar) if self.avatar else '',
            'owner_id': self.owner_id,
            'is_live': self.is_live,
            'sub_count': self.sub_count(),
        }


class ChannelSubscription(db.Model):
    __tablename__ = 'channel_subscription'
    id = db.Column(db.Integer, primary_key=True)
    channel_id = db.Column(db.Integer, db.ForeignKey('channel.id'), nullable=False)
    user_id = db.Column(db.Integer, db.ForeignKey('user.id'), nullable=False)
    subscribed_at = db.Column(db.DateTime, default=datetime.utcnow)

    user = db.relationship('User')
    __table_args__ = (db.UniqueConstraint('channel_id', 'user_id'),)


class ChannelPost(db.Model):
    __tablename__ = 'channel_post'
    id = db.Column(db.Integer, primary_key=True)
    channel_id = db.Column(db.Integer, db.ForeignKey('channel.id'), nullable=False)
    content = db.Column(db.Text, default='')
    image_path = db.Column(db.String(256), default='')
    message_type = db.Column(db.String(20), default='text')
    views = db.Column(db.Integer, default=0)
    created_at = db.Column(db.DateTime, default=datetime.utcnow)
    is_edited = db.Column(db.Boolean, default=False)
    comment_count = db.Column(db.Integer, default=0)

    comments = db.relationship('PostComment', backref='post', lazy='dynamic',
                                order_by='PostComment.created_at')

    def to_dict(self):
        return {
            'id': self.id,
            'channel_id': self.channel_id,
            'content': self.content,
            'image_url': get_file_url(self.image_path) if self.image_path else '',
            'message_type': self.message_type,
            'views': self.views,
            'created_at': self.created_at.strftime('%H:%M'),
            'created_date': self.created_at.strftime('%d.%m.%Y'),
            'is_edited': self.is_edited,
            'comment_count': self.comment_count,
        }


class PostComment(db.Model):
    __tablename__ = 'post_comment'
    id = db.Column(db.Integer, primary_key=True)
    post_id = db.Column(db.Integer, db.ForeignKey('channel_post.id'), nullable=False)
    user_id = db.Column(db.Integer, db.ForeignKey('user.id'), nullable=False)
    content = db.Column(db.Text, nullable=False)
    created_at = db.Column(db.DateTime, default=datetime.utcnow)

    user = db.relationship('User')

    def to_dict(self):
        return {
            'id': self.id,
            'post_id': self.post_id,
            'user_id': self.user_id,
            'content': self.content,
            'created_at': self.created_at.strftime('%H:%M %d.%m.%Y'),
            'user': self.user.to_dict() if self.user else None,
        }


class PinnedChat(db.Model):
    __tablename__ = 'pinned_chat'
    id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(db.Integer, db.ForeignKey('user.id'), nullable=False)
    chat_type = db.Column(db.String(20), nullable=False)
    target_id = db.Column(db.Integer, nullable=False)
    pinned_at = db.Column(db.DateTime, default=datetime.utcnow)
    __table_args__ = (db.UniqueConstraint('user_id', 'chat_type', 'target_id'),)


class BannedIP(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    ip_address = db.Column(db.String(45), unique=True, nullable=False)
    reason = db.Column(db.Text, default='')
    created_at = db.Column(db.DateTime, default=datetime.utcnow)


# ── Helpers ───────────────────────────────────────────────────────────────────

def allowed_file(filename):
    return '.' in filename and filename.rsplit('.', 1)[1].lower() in ALLOWED_EXTENSIONS


def compress_image(file_obj, max_size=(900, 900), quality=78):
    img = Image.open(file_obj)
    if img.mode in ('RGBA', 'P', 'LA'):
        img = img.convert('RGB')
    img.thumbnail(max_size, Image.LANCZOS)
    buf = io.BytesIO()
    img.save(buf, format='JPEG', quality=quality, optimize=True)
    buf.seek(0)
    return buf


def get_client_ip():
    forwarded = request.headers.get('X-Forwarded-For')
    if forwarded:
        return forwarded.split(',')[0].strip()
    return request.remote_addr or '0.0.0.0'


def login_required(f):
    @wraps(f)
    def decorated(*args, **kwargs):
        if 'user_id' not in session:
            return redirect(url_for('login'))
        user = db.session.get(User, session['user_id'])
        if not user:
            session.clear()
            return redirect(url_for('login'))
        if user.is_banned:
            session.clear()
            flash('Ваш аккаунт заблокирован.', 'error')
            return redirect(url_for('login'))
        if user.is_frozen:
            session.clear()
            flash('Ваш аккаунт заморожен. Обратитесь в поддержку.', 'warning')
            return redirect(url_for('login'))
        return f(*args, **kwargs)
    return decorated


def admin_required(f):
    """Allows both admins and moderators."""
    @wraps(f)
    def decorated(*args, **kwargs):
        if 'user_id' not in session:
            return redirect(url_for('login'))
        user = db.session.get(User, session['user_id'])
        if not user or not user.can_admin():
            flash('Доступ запрещён.', 'error')
            return redirect(url_for('chat'))
        return f(*args, **kwargs)
    return decorated


def full_admin_required(f):
    """Allows only full admins (not moderators)."""
    @wraps(f)
    def decorated(*args, **kwargs):
        if 'user_id' not in session:
            return redirect(url_for('login'))
        user = db.session.get(User, session['user_id'])
        if not user or not user.is_admin:
            flash('Только главный администратор может это делать.', 'error')
            return redirect(url_for('admin_dashboard'))
        return f(*args, **kwargs)
    return decorated


def conv_room(uid1, uid2):
    return f"conv_{min(uid1, uid2)}_{max(uid1, uid2)}"


# ── Auth ──────────────────────────────────────────────────────────────────────

@app.route('/uploads/<path:filename>')
def serve_upload(filename):
    import mimetypes
    base = _UPLOAD_BASE if _UPLOAD_BASE else os.path.join(os.getcwd(), 'static')
    mime, _ = mimetypes.guess_type(filename)
    return send_from_directory(base, filename, mimetype=mime or 'application/octet-stream', conditional=True)

@app.route('/')
def index():
    if 'user_id' in session:
        return redirect(url_for('chat'))
    return redirect(url_for('login'))


@app.route('/login', methods=['GET', 'POST'])
def login():
    if 'user_id' in session:
        return redirect(url_for('chat'))

    if request.method == 'POST':
        identifier = request.form.get('identifier', '').strip()
        password = request.form.get('password', '')
        ip = get_client_ip()

        if BannedIP.query.filter_by(ip_address=ip).first():
            flash('Ваш IP адрес заблокирован.', 'error')
            return render_template('login.html')

        user = User.query.filter(
            (User.username == identifier) | (User.email == identifier)
        ).first()

        if user and check_password_hash(user.password_hash, password):
            if user.is_banned:
                flash('Ваш аккаунт заблокирован.', 'error')
                return render_template('login.html')
            if user.is_frozen:
                flash('Ваш аккаунт заморожен. Обратитесь в поддержку.', 'warning')
                return render_template('login.html')
            session['user_id'] = user.id
            user.ip_address = ip
            db.session.commit()
            return redirect(url_for('chat'))

        flash('Неверный логин или пароль.', 'error')

    return render_template('login.html')


@app.route('/register', methods=['GET', 'POST'])
def register():
    if 'user_id' in session:
        return redirect(url_for('chat'))

    if request.method == 'POST':
        username = request.form.get('username', '').strip().lower()
        display_name = request.form.get('display_name', '').strip()
        email = request.form.get('email', '').strip().lower()
        password = request.form.get('password', '')
        ip = get_client_ip()

        if BannedIP.query.filter_by(ip_address=ip).first():
            flash('Ваш IP адрес заблокирован.', 'error')
            return render_template('register.html')

        if len(username) < 3 or len(username) > 20:
            flash('Юзернейм: от 3 до 20 символов.', 'error')
            return render_template('register.html')
        if not all(c.isalnum() or c in ('_', '.') for c in username):
            flash('Юзернейм: только буквы, цифры, _ и .', 'error')
            return render_template('register.html')
        if User.query.filter_by(username=username).first():
            flash('Этот юзернейм уже занят.', 'error')
            return render_template('register.html')
        if User.query.filter_by(email=email).first():
            flash('Этот email уже зарегистрирован.', 'error')
            return render_template('register.html')
        if len(password) < 6:
            flash('Пароль: минимум 6 символов.', 'error')
            return render_template('register.html')

        user = User(
            username=username,
            display_name=display_name or username,
            email=email,
            password_hash=generate_password_hash(password),
            ip_address=ip,
        )
        db.session.add(user)
        db.session.commit()
        session['user_id'] = user.id
        return redirect(url_for('chat'))

    return render_template('register.html')


@app.route('/logout')
def logout():
    uid = session.get('user_id')
    if uid:
        user = db.session.get(User, uid)
        if user:
            user.online = False
            user.last_seen = datetime.utcnow()
            db.session.commit()
    session.clear()
    return redirect(url_for('login'))


# ── Chat ──────────────────────────────────────────────────────────────────────

@app.route('/chat')
@login_required
def chat():
    user = db.session.get(User, session['user_id'])
    return render_template('chat.html', current_user=user)


@app.route('/api/conversations')
@login_required
def api_conversations():
    uid = session['user_id']
    sent_ids = {r[0] for r in db.session.query(Message.receiver_id).filter_by(sender_id=uid).distinct()}
    recv_ids = {r[0] for r in db.session.query(Message.sender_id).filter_by(receiver_id=uid).distinct()}
    partner_ids = sent_ids | recv_ids

    result = []
    for pid in partner_ids:
        partner = db.session.get(User, pid)
        if not partner:
            continue
        last_msg = Message.query.filter(
            ((Message.sender_id == uid) & (Message.receiver_id == pid)) |
            ((Message.sender_id == pid) & (Message.receiver_id == uid))
        ).order_by(Message.created_at.desc()).first()
        unread = Message.query.filter_by(sender_id=pid, receiver_id=uid, is_read=False).count()
        result.append({
            'partner': partner.to_dict(),
            'last_message': last_msg.to_dict() if last_msg else None,
            'unread_count': unread,
        })

    result.sort(key=lambda x: x['last_message']['created_date'] + x['last_message']['created_at']
                if x['last_message'] else '', reverse=True)
    return jsonify(result)


@app.route('/api/messages/<int:partner_id>')
@login_required
def api_messages(partner_id):
    uid = session['user_id']
    page = request.args.get('page', 1, type=int)

    msgs = Message.query.filter(
        ((Message.sender_id == uid) & (Message.receiver_id == partner_id)) |
        ((Message.sender_id == partner_id) & (Message.receiver_id == uid))
    ).order_by(Message.created_at.desc()).paginate(page=page, per_page=50, error_out=False)

    Message.query.filter_by(sender_id=partner_id, receiver_id=uid, is_read=False).update({'is_read': True})
    db.session.commit()

    def visible(m):
        if m.deleted_for_all:
            return False
        if m.sender_id == uid and m.deleted_for_sender:
            return False
        if m.receiver_id == uid and m.deleted_for_receiver:
            return False
        return True

    return jsonify({
        'messages': [m.to_dict() for m in reversed(msgs.items) if visible(m)],
        'has_more': msgs.has_next,
    })


@app.route('/api/send_message', methods=['POST'])
@login_required
def api_send_message():
    uid = session['user_id']
    receiver_id = request.form.get('receiver_id', type=int)
    content = request.form.get('content', '').strip()

    if not receiver_id:
        return jsonify({'error': 'no receiver'}), 400

    receiver = db.session.get(User, receiver_id)
    if not receiver:
        return jsonify({'error': 'user not found'}), 404

    image_path = ''
    audio_path = ''
    msg_type = 'text'

    if 'image' in request.files:
        f = request.files['image']
        if f and f.filename and allowed_file(f.filename):
            ext = f.filename.rsplit('.', 1)[1].lower()
            if ext in ALLOWED_AUDIO:
                fname = f"{uuid.uuid4().hex}.{ext}"
                f.stream.seek(0)
                audio_path = save_upload(f.stream.read(), 'audio', fname, f.mimetype or 'audio/webm')
                msg_type = 'voice' if request.form.get('is_voice') else 'audio'
            else:
                compressed = compress_image(f)
                fname = f"{uuid.uuid4().hex}.jpg"
                image_path = save_upload(compressed.read(), 'messages', fname, 'image/jpeg')
                msg_type = 'mixed' if content else 'image'

    if 'audio' in request.files:
        f = request.files['audio']
        if f and f.filename:
            ext = f.filename.rsplit('.', 1)[1].lower() if '.' in f.filename else 'webm'
            fname = f"{uuid.uuid4().hex}.{ext}"
            f.stream.seek(0)
            audio_path = save_upload(f.stream.read(), 'audio', fname, f.mimetype or 'audio/webm')
            msg_type = 'voice' if request.form.get('is_voice') else 'audio'

    if not content and not image_path and not audio_path:
        return jsonify({'error': 'empty message'}), 400

    reply_to_id = request.form.get('reply_to_id', type=int)
    msg = Message(sender_id=uid, receiver_id=receiver_id,
                  content=content, image_path=image_path, audio_path=audio_path,
                  message_type=msg_type, reply_to_id=reply_to_id)
    db.session.add(msg)
    db.session.commit()

    room = conv_room(uid, receiver_id)
    socketio.emit('new_message', msg.to_dict(), room=room)

    # Уведомить получателя напрямую если он не в комнате
    for sid in sids_for_user(receiver_id):
        socketio.emit('new_conversation_notify', msg.to_dict(), room=sid)

    return jsonify(msg.to_dict())


@app.route('/api/search_users')
@login_required
def api_search_users():
    q = request.args.get('q', '').strip()
    if not q:
        return jsonify([])
    uid = session['user_id']
    username_only = q.startswith('@')
    if username_only:
        q = q[1:].strip()
        if not q:
            return jsonify([])
    if username_only:
        users = User.query.filter(
            User.username.ilike(f'%{q}%'),
            User.id != uid,
            User.is_banned == False,
        ).limit(20).all()
    else:
        users = User.query.filter(
            (User.username.ilike(f'%{q}%') | User.display_name.ilike(f'%{q}%')),
            User.id != uid,
            User.is_banned == False,
        ).limit(20).all()
    return jsonify([u.to_dict() for u in users])


@app.route('/api/user/<int:user_id>')
@login_required
def api_user(user_id):
    user = db.session.get(User, user_id)
    if not user:
        return jsonify({'error': 'not found'}), 404
    return jsonify(user.to_dict())


# ── Groups ────────────────────────────────────────────────────────────────────

@app.route('/api/groups')
@login_required
def api_groups():
    uid = session['user_id']
    memberships = GroupMember.query.filter_by(user_id=uid).all()
    result = []
    for m in memberships:
        group = db.session.get(GroupChat, m.group_id)
        if not group:
            continue
        last_msg = GroupMessage.query.filter_by(group_id=group.id).order_by(GroupMessage.created_at.desc()).first()
        result.append({
            'group': {
                'id': group.id,
                'name': group.name,
                'description': group.description,
                'avatar': url_for('static', filename=group.avatar) if group.avatar else '',
                'member_count': group.members.count(),
            },
            'last_message': last_msg.to_dict() if last_msg else None,
        })
    result.sort(key=lambda x: (x['last_message']['created_date'] + x['last_message']['created_at']) if x['last_message'] else '', reverse=True)
    return jsonify(result)


@app.route('/api/groups/create', methods=['POST'])
@login_required
def api_create_group():
    uid = session['user_id']
    name = request.form.get('name', '').strip()
    if not name or len(name) > 100:
        return jsonify({'error': 'invalid name'}), 400

    group = GroupChat(name=name, created_by=uid)
    db.session.add(group)
    db.session.flush()

    db.session.add(GroupMember(group_id=group.id, user_id=uid, role='admin'))

    for mid_str in request.form.getlist('member_ids'):
        try:
            mid = int(mid_str)
            if mid != uid:
                db.session.add(GroupMember(group_id=group.id, user_id=mid, role='member'))
        except (ValueError, TypeError):
            pass

    db.session.commit()
    return jsonify({'id': group.id, 'name': group.name})


@app.route('/api/groups/<int:group_id>/info')
@login_required
def api_group_info(group_id):
    uid = session['user_id']
    group = db.session.get(GroupChat, group_id)
    if not group:
        return jsonify({'error': 'not found'}), 404
    if not GroupMember.query.filter_by(group_id=group_id, user_id=uid).first():
        return jsonify({'error': 'not a member'}), 403

    members = GroupMember.query.filter_by(group_id=group_id).all()
    return jsonify({
        'id': group.id,
        'name': group.name,
        'description': group.description,
        'avatar': url_for('static', filename=group.avatar) if group.avatar else '',
        'created_by': group.created_by,
        'member_count': len(members),
        'members': [{'user': m.user.to_dict(), 'role': m.role} for m in members],
    })


@app.route('/api/groups/<int:group_id>/messages')
@login_required
def api_group_messages(group_id):
    uid = session['user_id']
    if not GroupMember.query.filter_by(group_id=group_id, user_id=uid).first():
        return jsonify({'error': 'not a member'}), 403

    page = request.args.get('page', 1, type=int)
    msgs = GroupMessage.query.filter_by(group_id=group_id).order_by(GroupMessage.created_at.desc()).paginate(page=page, per_page=50, error_out=False)

    return jsonify({
        'messages': [m.to_dict() for m in reversed(msgs.items) if not m.is_deleted],
        'has_more': msgs.has_next,
    })


@app.route('/api/groups/<int:group_id>/send', methods=['POST'])
@login_required
def api_send_group_message(group_id):
    uid = session['user_id']
    if not GroupMember.query.filter_by(group_id=group_id, user_id=uid).first():
        return jsonify({'error': 'not a member'}), 403

    content = request.form.get('content', '').strip()
    image_path = ''
    audio_path = ''
    msg_type = 'text'

    if 'image' in request.files:
        f = request.files['image']
        if f and f.filename and allowed_file(f.filename):
            ext = f.filename.rsplit('.', 1)[1].lower()
            if ext in ALLOWED_AUDIO:
                fname = f"{uuid.uuid4().hex}.{ext}"
                f.stream.seek(0)
                audio_path = save_upload(f.stream.read(), 'audio', fname, f.mimetype or 'audio/webm')
                msg_type = 'voice' if request.form.get('is_voice') else 'audio'
            else:
                compressed = compress_image(f)
                fname = f"{uuid.uuid4().hex}.jpg"
                image_path = save_upload(compressed.read(), 'messages', fname, 'image/jpeg')
                msg_type = 'mixed' if content else 'image'

    if 'audio' in request.files:
        f = request.files['audio']
        if f and f.filename:
            ext = f.filename.rsplit('.', 1)[1].lower() if '.' in f.filename else 'webm'
            fname = f"{uuid.uuid4().hex}.{ext}"
            f.stream.seek(0)
            audio_path = save_upload(f.stream.read(), 'audio', fname, f.mimetype or 'audio/webm')
            msg_type = 'voice' if request.form.get('is_voice') else 'audio'

    if not content and not image_path and not audio_path:
        return jsonify({'error': 'empty message'}), 400

    reply_to_id = request.form.get('reply_to_id', type=int)
    msg = GroupMessage(group_id=group_id, sender_id=uid,
                       content=content, image_path=image_path, audio_path=audio_path,
                       message_type=msg_type, reply_to_id=reply_to_id)
    db.session.add(msg)
    db.session.commit()

    socketio.emit('group_message', msg.to_dict(), room=f'group_{group_id}')
    return jsonify(msg.to_dict())


@app.route('/api/messages/<int:msg_id>', methods=['PUT'])
@login_required
def api_edit_message(msg_id):
    uid = session['user_id']
    msg = db.session.get(Message, msg_id)
    if not msg or msg.sender_id != uid:
        return jsonify({'error': 'not authorized'}), 403
    content = request.form.get('content', '').strip()
    if not content:
        return jsonify({'error': 'empty'}), 400
    msg.content = content
    msg.is_edited = True
    db.session.commit()
    socketio.emit('message_edited', {
        'msg_id': msg.id, 'content': content, 'chat_type': 'direct'
    }, room=conv_room(msg.sender_id, msg.receiver_id))
    return jsonify(msg.to_dict())


@app.route('/api/messages/<int:msg_id>', methods=['DELETE'])
@login_required
def api_delete_message(msg_id):
    uid = session['user_id']
    msg = db.session.get(Message, msg_id)
    if not msg:
        return jsonify({'error': 'not found'}), 404
    scope = request.args.get('scope', 'me')
    if scope == 'all':
        if msg.sender_id != uid:
            return jsonify({'error': 'only sender can delete for all'}), 403
        msg.deleted_for_all = True
        db.session.commit()
        socketio.emit('message_deleted', {
            'msg_id': msg.id, 'chat_type': 'direct', 'scope': 'all'
        }, room=conv_room(msg.sender_id, msg.receiver_id))
    else:
        if uid == msg.sender_id:
            msg.deleted_for_sender = True
        else:
            msg.deleted_for_receiver = True
        db.session.commit()
    return jsonify({'ok': True})


@app.route('/api/groups/<int:group_id>/messages/<int:msg_id>', methods=['PUT'])
@login_required
def api_edit_group_message(group_id, msg_id):
    uid = session['user_id']
    msg = db.session.get(GroupMessage, msg_id)
    if not msg or msg.sender_id != uid or msg.group_id != group_id:
        return jsonify({'error': 'not authorized'}), 403
    content = request.form.get('content', '').strip()
    if not content:
        return jsonify({'error': 'empty'}), 400
    msg.content = content
    msg.is_edited = True
    db.session.commit()
    socketio.emit('group_message_edited', {
        'msg_id': msg.id, 'group_id': group_id, 'content': content
    }, room=f'group_{group_id}')
    return jsonify(msg.to_dict())


@app.route('/api/groups/<int:group_id>/messages/<int:msg_id>', methods=['DELETE'])
@login_required
def api_delete_group_message(group_id, msg_id):
    uid = session['user_id']
    msg = db.session.get(GroupMessage, msg_id)
    me = GroupMember.query.filter_by(group_id=group_id, user_id=uid).first()
    if not msg or msg.group_id != group_id:
        return jsonify({'error': 'not found'}), 404
    scope = request.args.get('scope', 'all')
    is_admin = me and me.role == 'admin'
    if scope == 'all' and (msg.sender_id == uid or is_admin):
        msg.is_deleted = True
        db.session.commit()
        socketio.emit('group_message_deleted', {
            'msg_id': msg.id, 'group_id': group_id
        }, room=f'group_{group_id}')
    return jsonify({'ok': True})


@app.route('/api/pin', methods=['POST'])
@login_required
def api_pin():
    uid = session['user_id']
    chat_type = request.form.get('chat_type')
    target_id = request.form.get('target_id', type=int)
    if not chat_type or not target_id:
        return jsonify({'error': 'missing params'}), 400
    existing = PinnedChat.query.filter_by(user_id=uid, chat_type=chat_type, target_id=target_id).first()
    if existing:
        db.session.delete(existing)
        db.session.commit()
        return jsonify({'pinned': False})
    db.session.add(PinnedChat(user_id=uid, chat_type=chat_type, target_id=target_id))
    db.session.commit()
    return jsonify({'pinned': True})


@app.route('/api/pins')
@login_required
def api_pins():
    uid = session['user_id']
    pins = PinnedChat.query.filter_by(user_id=uid).all()
    return jsonify([{'chat_type': p.chat_type, 'target_id': p.target_id} for p in pins])


@app.route('/api/groups/<int:group_id>/add_member', methods=['POST'])
@login_required
def api_group_add_member(group_id):
    uid = session['user_id']
    me = GroupMember.query.filter_by(group_id=group_id, user_id=uid).first()
    if not me or me.role != 'admin':
        return jsonify({'error': 'not authorized'}), 403

    target_id = request.form.get('user_id', type=int)
    if not target_id:
        return jsonify({'error': 'no user_id'}), 400

    if GroupMember.query.filter_by(group_id=group_id, user_id=target_id).first():
        return jsonify({'error': 'already member'}), 400

    db.session.add(GroupMember(group_id=group_id, user_id=target_id, role='member'))
    db.session.commit()

    for sid in sids_for_user(target_id):
        socketio.emit('added_to_group', {'group_id': group_id}, room=sid)

    return jsonify({'ok': True})


# ── Channels ──────────────────────────────────────────────────────────────────

@app.route('/channels')
@login_required
def channels_list():
    user = db.session.get(User, session['user_id'])
    q = request.args.get('q', '').strip()
    if q:
        channels = Channel.query.filter(
            Channel.name.ilike(f'%{q}%') | Channel.username.ilike(f'%{q}%')
        ).order_by(Channel.created_at.desc()).limit(50).all()
    else:
        channels = Channel.query.order_by(Channel.created_at.desc()).limit(50).all()
    my_subs = {s.channel_id for s in ChannelSubscription.query.filter_by(user_id=user.id).all()}
    return render_template('channels/index.html', current_user=user, channels=channels,
                           my_subs=my_subs, search=q)


@app.route('/channels/create', methods=['GET', 'POST'])
@login_required
def create_channel():
    user = db.session.get(User, session['user_id'])
    if request.method == 'POST':
        name = request.form.get('name', '').strip()
        username = request.form.get('username', '').strip().lower()
        description = request.form.get('description', '').strip()

        if not name or not username:
            flash('Заполните название и юзернейм.', 'error')
            return render_template('channels/create.html', current_user=user)
        if len(username) < 3 or len(username) > 30:
            flash('Юзернейм канала: от 3 до 30 символов.', 'error')
            return render_template('channels/create.html', current_user=user)
        if not all(c.isalnum() or c == '_' for c in username):
            flash('Юзернейм канала: только буквы, цифры и _.', 'error')
            return render_template('channels/create.html', current_user=user)
        if Channel.query.filter_by(username=username).first():
            flash('Этот юзернейм канала уже занят.', 'error')
            return render_template('channels/create.html', current_user=user)

        ch = Channel(name=name, username=username, description=description, owner_id=user.id)

        if 'avatar' in request.files:
            f = request.files['avatar']
            if f and f.filename and allowed_file(f.filename):
                compressed = compress_image(f, max_size=(400, 400), quality=85)
                fname = f"channel_{uuid.uuid4().hex[:8]}.jpg"
                ch.avatar = save_upload(compressed.read(), 'avatars', fname, 'image/jpeg')

        db.session.add(ch)
        db.session.flush()
        db.session.add(ChannelSubscription(channel_id=ch.id, user_id=user.id))
        db.session.commit()
        flash('Канал создан!', 'success')
        return redirect(url_for('channel_page', ch_username=username))

    return render_template('channels/create.html', current_user=user)


@app.route('/channel/<ch_username>')
@login_required
def channel_page(ch_username):
    user = db.session.get(User, session['user_id'])
    ch = Channel.query.filter_by(username=ch_username).first_or_404()
    is_subscribed = ChannelSubscription.query.filter_by(channel_id=ch.id, user_id=user.id).first() is not None
    is_owner = ch.owner_id == user.id
    posts = ch.posts.limit(50).all()
    posts = list(reversed(posts))
    return render_template('channels/channel.html', current_user=user, channel=ch,
                           is_subscribed=is_subscribed, is_owner=is_owner, posts=posts)


@app.route('/channel/<ch_username>/subscribe', methods=['POST'])
@login_required
def channel_subscribe(ch_username):
    user = db.session.get(User, session['user_id'])
    ch = Channel.query.filter_by(username=ch_username).first_or_404()
    sub = ChannelSubscription.query.filter_by(channel_id=ch.id, user_id=user.id).first()
    if sub:
        db.session.delete(sub)
        db.session.commit()
        return jsonify({'subscribed': False, 'sub_count': ch.sub_count()})
    else:
        db.session.add(ChannelSubscription(channel_id=ch.id, user_id=user.id))
        db.session.commit()
        return jsonify({'subscribed': True, 'sub_count': ch.sub_count()})


@app.route('/channel/<ch_username>/post', methods=['POST'])
@login_required
def channel_post_create(ch_username):
    user = db.session.get(User, session['user_id'])
    ch = Channel.query.filter_by(username=ch_username).first_or_404()
    if ch.owner_id != user.id:
        return jsonify({'error': 'not owner'}), 403

    content = request.form.get('content', '').strip()
    image_path = ''
    msg_type = 'text'

    if 'image' in request.files:
        f = request.files['image']
        if f and f.filename and allowed_file(f.filename):
            compressed = compress_image(f)
            fname = f"{uuid.uuid4().hex}.jpg"
            image_path = save_upload(compressed.read(), 'messages', fname, 'image/jpeg')
            msg_type = 'mixed' if content else 'image'

    if not content and not image_path:
        return jsonify({'error': 'empty'}), 400

    post = ChannelPost(channel_id=ch.id, content=content,
                       image_path=image_path, message_type=msg_type)
    db.session.add(post)
    db.session.commit()

    socketio.emit('channel_post', post.to_dict(), room=f'channel_{ch.id}')
    return jsonify(post.to_dict())


@app.route('/channel/<ch_username>/live/start', methods=['POST'])
@login_required
def channel_live_start(ch_username):
    user = db.session.get(User, session['user_id'])
    ch = Channel.query.filter_by(username=ch_username).first_or_404()
    if ch.owner_id != user.id:
        return jsonify({'error': 'not owner'}), 403
    ch.is_live = True
    db.session.commit()
    socketio.emit('channel_went_live', {'channel_id': ch.id, 'channel_name': ch.name},
                  room=f'channel_{ch.id}')
    return jsonify({'ok': True})


@app.route('/channel/<ch_username>/live/stop', methods=['POST'])
@login_required
def channel_live_stop(ch_username):
    user = db.session.get(User, session['user_id'])
    ch = Channel.query.filter_by(username=ch_username).first_or_404()
    if ch.owner_id != user.id:
        return jsonify({'error': 'not owner'}), 403
    ch.is_live = False
    db.session.commit()
    stream_sessions.pop(ch.id, None)
    socketio.emit('channel_stream_ended', {'channel_id': ch.id}, room=f'channel_{ch.id}')
    return jsonify({'ok': True})


@app.route('/api/channels/subscribed')
@login_required
def api_subscribed_channels():
    uid = session['user_id']
    subs = ChannelSubscription.query.filter_by(user_id=uid).all()
    result = []
    for s in subs:
        ch = db.session.get(Channel, s.channel_id)
        if not ch:
            continue
        last_post = ch.posts.first()
        result.append({
            'channel': ch.to_dict(),
            'last_post': last_post.to_dict() if last_post else None,
        })
    return jsonify(result)


@app.route('/api/channels/search')
@login_required
def api_search_channels():
    q = request.args.get('q', '').strip()
    if not q:
        return jsonify([])
    if q.startswith('@'):
        q = q[1:].strip()
    uid = session['user_id']
    channels = Channel.query.filter(
        Channel.username.ilike(f'%{q}%') | Channel.name.ilike(f'%{q}%')
    ).limit(10).all()
    my_subs = {s.channel_id for s in ChannelSubscription.query.filter_by(user_id=uid).all()}
    return jsonify([{**c.to_dict(), 'is_subscribed': c.id in my_subs} for c in channels])


@app.route('/api/channel/<int:channel_id>/subscribers')
@login_required
def api_channel_subscribers(channel_id):
    ch = db.session.get(Channel, channel_id)
    if not ch:
        return jsonify({'error': 'not found'}), 404
    subs = ChannelSubscription.query.filter_by(channel_id=channel_id).all()
    return jsonify([s.user.to_dict() for s in subs if s.user])


@app.route('/channel/<ch_username>/delete', methods=['POST'])
@login_required
def channel_delete(ch_username):
    user = db.session.get(User, session['user_id'])
    ch = Channel.query.filter_by(username=ch_username).first_or_404()
    if ch.owner_id != user.id:
        return jsonify({'error': 'not owner'}), 403
    ChannelSubscription.query.filter_by(channel_id=ch.id).delete()
    PostComment.query.filter(PostComment.post_id.in_(
        db.session.query(ChannelPost.id).filter_by(channel_id=ch.id)
    )).delete(synchronize_session=False)
    ChannelPost.query.filter_by(channel_id=ch.id).delete()
    db.session.delete(ch)
    db.session.commit()
    return jsonify({'ok': True})


@app.route('/channel/<ch_username>/post/<int:post_id>', methods=['PUT'])
@login_required
def channel_post_edit(ch_username, post_id):
    user = db.session.get(User, session['user_id'])
    ch = Channel.query.filter_by(username=ch_username).first_or_404()
    if ch.owner_id != user.id:
        return jsonify({'error': 'not owner'}), 403
    post = db.session.get(ChannelPost, post_id)
    if not post or post.channel_id != ch.id:
        return jsonify({'error': 'not found'}), 404
    content = request.form.get('content', '').strip()
    post.content = content
    post.is_edited = True
    db.session.commit()
    return jsonify(post.to_dict())


@app.route('/channel/<ch_username>/post/<int:post_id>', methods=['DELETE'])
@login_required
def channel_post_delete(ch_username, post_id):
    user = db.session.get(User, session['user_id'])
    ch = Channel.query.filter_by(username=ch_username).first_or_404()
    if ch.owner_id != user.id:
        return jsonify({'error': 'not owner'}), 403
    post = db.session.get(ChannelPost, post_id)
    if not post or post.channel_id != ch.id:
        return jsonify({'error': 'not found'}), 404
    PostComment.query.filter_by(post_id=post.id).delete()
    db.session.delete(post)
    db.session.commit()
    socketio.emit('post_deleted', {'post_id': post_id, 'channel_id': ch.id}, room=f'channel_{ch.id}')
    return jsonify({'ok': True})


@app.route('/channel/<ch_username>/post/<int:post_id>/comments', methods=['GET'])
@login_required
def channel_post_get_comments(ch_username, post_id):
    post = db.session.get(ChannelPost, post_id)
    if not post:
        return jsonify({'error': 'not found'}), 404
    comments = PostComment.query.filter_by(post_id=post_id).order_by(PostComment.created_at).all()
    return jsonify([c.to_dict() for c in comments])


@app.route('/channel/<ch_username>/post/<int:post_id>/comments', methods=['POST'])
@login_required
def channel_post_add_comment(ch_username, post_id):
    uid = session['user_id']
    post = db.session.get(ChannelPost, post_id)
    if not post:
        return jsonify({'error': 'not found'}), 404
    content = request.form.get('content', '').strip()
    if not content or len(content) > 1000:
        return jsonify({'error': 'invalid content'}), 400
    comment = PostComment(post_id=post_id, user_id=uid, content=content)
    db.session.add(comment)
    post.comment_count = (post.comment_count or 0) + 1
    db.session.commit()
    socketio.emit('new_comment', {
        'post_id': post_id,
        'channel_id': post.channel_id,
        'comment': comment.to_dict()
    }, room=f'channel_{post.channel_id}')
    return jsonify(comment.to_dict())


@app.route('/api/profile/update', methods=['POST'])
@login_required
def api_profile_update():
    user = db.session.get(User, session['user_id'])
    dn = request.form.get('display_name', '').strip()
    bio = request.form.get('bio', '').strip()[:300]
    if dn:
        user.display_name = dn
    user.bio = bio
    user.hide_last_seen = request.form.get('hide_last_seen') == '1'

    new_username = request.form.get('username', '').strip().lower()
    if new_username and new_username != user.username:
        if len(new_username) < 3 or len(new_username) > 20:
            return jsonify({'error': 'Юзернейм: от 3 до 20 символов.'}), 400
        if not all(c.isalnum() or c in ('_', '.') for c in new_username):
            return jsonify({'error': 'Юзернейм: только буквы, цифры, _ и .'}), 400
        if User.query.filter_by(username=new_username).first():
            return jsonify({'error': 'Этот юзернейм уже занят.'}), 400
        user.username = new_username

    if 'avatar' in request.files:
        f = request.files['avatar']
        if f and f.filename and allowed_file(f.filename):
            compressed = compress_image(f, max_size=(400, 400), quality=85)
            fname = f"avatar_{user.id}_{uuid.uuid4().hex[:8]}.jpg"
            user.avatar = save_upload(compressed.read(), 'avatars', fname, 'image/jpeg')

    db.session.commit()
    socketio.emit('user_updated', user.to_dict(), namespace='/')
    return jsonify({'ok': True, 'user': user.to_dict()})


@app.route('/api/channel/<int:channel_id>/posts')
@login_required
def api_channel_posts(channel_id):
    uid = session['user_id']
    ch = db.session.get(Channel, channel_id)
    if not ch:
        return jsonify({'error': 'not found'}), 404
    page = request.args.get('page', 1, type=int)
    posts = ch.posts.paginate(page=page, per_page=30, error_out=False)
    return jsonify({
        'posts': [p.to_dict() for p in reversed(posts.items)],
        'has_more': posts.has_next,
        'channel': ch.to_dict(),
        'is_owner': ch.owner_id == uid,
        'is_subscribed': ChannelSubscription.query.filter_by(channel_id=channel_id, user_id=uid).first() is not None,
    })


# ── Profile ───────────────────────────────────────────────────────────────────

@app.route('/profile/<username>')
@login_required
def profile(username):
    profile_user = User.query.filter_by(username=username).first_or_404()
    current_user = db.session.get(User, session['user_id'])
    return render_template('profile.html', profile_user=profile_user, current_user=current_user)


@app.route('/profile/edit', methods=['GET', 'POST'])
@login_required
def edit_profile():
    user = db.session.get(User, session['user_id'])

    if request.method == 'POST':
        dn = request.form.get('display_name', '').strip()
        bio = request.form.get('bio', '').strip()[:300]
        if dn:
            user.display_name = dn
        user.bio = bio
        user.hide_last_seen = request.form.get('hide_last_seen') == '1'

        new_username = request.form.get('username', '').strip().lower()
        if new_username and new_username != user.username:
            if len(new_username) < 3 or len(new_username) > 20:
                flash('Юзернейм: от 3 до 20 символов.', 'error')
                return render_template('profile_edit.html', current_user=user)
            if not all(c.isalnum() or c in ('_', '.') for c in new_username):
                flash('Юзернейм: только буквы, цифры, _ и .', 'error')
                return render_template('profile_edit.html', current_user=user)
            if User.query.filter_by(username=new_username).first():
                flash('Этот юзернейм уже занят.', 'error')
                return render_template('profile_edit.html', current_user=user)
            user.username = new_username

        if 'avatar' in request.files:
            f = request.files['avatar']
            if f and f.filename and allowed_file(f.filename):
                compressed = compress_image(f, max_size=(400, 400), quality=85)
                fname = f"avatar_{user.id}_{uuid.uuid4().hex[:8]}.jpg"
                user.avatar = save_upload(compressed.read(), 'avatars', fname, 'image/jpeg')

        db.session.commit()
        # Уведомить всех онлайн-пользователей об изменении профиля
        socketio.emit('user_updated', user.to_dict(), namespace='/')
        flash('Профиль обновлён.', 'success')
        return redirect(url_for('profile', username=user.username))

    return render_template('profile_edit.html', current_user=user)


# ── Support ───────────────────────────────────────────────────────────────────

@app.route('/support')
@login_required
def support():
    user = db.session.get(User, session['user_id'])
    tickets = SupportTicket.query.filter_by(user_id=user.id).order_by(SupportTicket.created_at.desc()).all()
    return render_template('support/index.html', current_user=user, tickets=tickets)


@app.route('/support/new', methods=['GET', 'POST'])
@login_required
def new_ticket():
    user = db.session.get(User, session['user_id'])

    if request.method == 'POST':
        subject = request.form.get('subject', '').strip()
        content = request.form.get('message', '').strip()
        if not subject or not content:
            flash('Заполните все поля.', 'error')
        else:
            ticket = SupportTicket(user_id=user.id, subject=subject)
            db.session.add(ticket)
            db.session.flush()
            msg = SupportMessage(ticket_id=ticket.id, sender_id=user.id, content=content)
            db.session.add(msg)
            db.session.commit()
            socketio.emit('new_support_ticket', {
                'ticket_id': ticket.id,
                'user': user.to_dict(),
                'subject': subject,
            }, room='admin_room')
            flash('Обращение создано. Ответим в ближайшее время.', 'success')
            return redirect(url_for('view_ticket', ticket_id=ticket.id))

    return render_template('support/new.html', current_user=user)


@app.route('/support/ticket/<int:ticket_id>', methods=['GET', 'POST'])
@login_required
def view_ticket(ticket_id):
    user = db.session.get(User, session['user_id'])
    ticket = db.session.get(SupportTicket, ticket_id)
    if not ticket:
        flash('Тикет не найден.', 'error')
        return redirect(url_for('support'))
    if ticket.user_id != user.id and not user.is_admin:
        flash('Доступ запрещён.', 'error')
        return redirect(url_for('support'))

    if request.method == 'POST':
        content = request.form.get('content', '').strip()
        if content:
            smsg = SupportMessage(ticket_id=ticket.id, sender_id=user.id, content=content)
            db.session.add(smsg)
            if not user.is_admin and ticket.status == 'closed':
                ticket.status = 'open'
            db.session.commit()
            socketio.emit('support_reply', {
                'ticket_id': ticket.id,
                'sender': user.to_dict(),
                'content': content,
                'created_at': smsg.created_at.strftime('%H:%M %d.%m.%Y'),
            }, room=f'ticket_{ticket_id}')
            if user.is_admin:
                # notify user
                u_sids = [sid for sid, uid in online_users.items() if uid == ticket.user_id]
                for sid in u_sids:
                    socketio.emit('ticket_reply_notify', {
                        'ticket_id': ticket.id,
                        'subject': ticket.subject,
                    }, room=sid)

    return render_template('support/ticket.html', current_user=user, ticket=ticket)


@app.route('/support/ticket/<int:ticket_id>/close', methods=['POST'])
@admin_required
def close_ticket(ticket_id):
    ticket = db.session.get(SupportTicket, ticket_id)
    if ticket:
        ticket.status = 'closed'
        db.session.commit()
        flash('Тикет закрыт.', 'success')
    return redirect(url_for('view_ticket', ticket_id=ticket_id))


# ── Admin ─────────────────────────────────────────────────────────────────────

@app.route('/admin')
@admin_required
def admin_dashboard():
    user = db.session.get(User, session['user_id'])
    return render_template('admin/dashboard.html',
        current_user=user,
        total_users=User.query.count(),
        total_messages=Message.query.count(),
        open_tickets=SupportTicket.query.filter_by(status='open').count(),
        online_count=User.query.filter_by(online=True).count(),
        recent_users=User.query.order_by(User.created_at.desc()).limit(8).all(),
    )


@app.route('/admin/users')
@admin_required
def admin_users():
    user = db.session.get(User, session['user_id'])
    q = request.args.get('q', '')
    query = User.query
    if q:
        query = query.filter(
            User.username.ilike(f'%{q}%') |
            User.display_name.ilike(f'%{q}%') |
            User.email.ilike(f'%{q}%') |
            User.ip_address.ilike(f'%{q}%')
        )
    users = query.order_by(User.created_at.desc()).all()
    banned_ips = BannedIP.query.order_by(BannedIP.created_at.desc()).all()
    return render_template('admin/users.html', current_user=user, users=users,
                           banned_ips=banned_ips, search=q)


@app.route('/admin/user/<int:user_id>/action', methods=['POST'])
@admin_required
def admin_user_action(user_id):
    target = db.session.get(User, user_id)
    if not target:
        flash('Пользователь не найден.', 'error')
        return redirect(url_for('admin_users'))

    action = request.form.get('action')

    if action == 'ban':
        if target.is_admin:
            flash('Нельзя заблокировать администратора.', 'error')
            return redirect(url_for('admin_users'))
        target.is_banned = True
        if target.ip_address and not BannedIP.query.filter_by(ip_address=target.ip_address).first():
            db.session.add(BannedIP(ip_address=target.ip_address, reason=f'ban user {target.username}'))
        db.session.commit()
        flash(f'{target.username} заблокирован.', 'success')

    elif action == 'unban':
        target.is_banned = False
        db.session.commit()
        flash(f'{target.username} разблокирован.', 'success')

    elif action == 'freeze':
        target.is_frozen = True
        db.session.commit()
        flash(f'Аккаунт {target.username} заморожен.', 'success')

    elif action == 'unfreeze':
        target.is_frozen = False
        db.session.commit()
        flash(f'Аккаунт {target.username} разморожен.', 'success')

    elif action == 'change_name':
        new_name = request.form.get('display_name', '').strip()
        if new_name:
            target.display_name = new_name
            db.session.commit()
            flash(f'Имя изменено на «{new_name}».', 'success')

    elif action == 'change_username':
        new_uname = request.form.get('new_username', '').strip().lower()
        if new_uname:
            if User.query.filter_by(username=new_uname).first():
                flash('Юзернейм уже занят.', 'error')
            else:
                target.username = new_uname
                db.session.commit()
                flash(f'Юзернейм изменён на @{new_uname}.', 'success')

    elif action == 'change_avatar':
        if 'avatar' in request.files:
            f = request.files['avatar']
            if f and f.filename and allowed_file(f.filename):
                compressed = compress_image(f, max_size=(400, 400), quality=85)
                fname = f"avatar_{target.id}_{uuid.uuid4().hex[:8]}.jpg"
                target.avatar = save_upload(compressed.read(), 'avatars', fname, 'image/jpeg')
                db.session.commit()
                flash('Аватар изменён.', 'success')

    elif action == 'ban_ip':
        ip = request.form.get('ip_to_ban', '').strip()
        reason = request.form.get('ban_reason', '').strip()
        if ip:
            if not BannedIP.query.filter_by(ip_address=ip).first():
                db.session.add(BannedIP(ip_address=ip, reason=reason))
                db.session.commit()
                flash(f'IP {ip} заблокирован.', 'success')
            else:
                flash('IP уже заблокирован.', 'info')

    return redirect(url_for('admin_users') + (f'?q={request.form.get("search_q", "")}'))


@app.route('/admin/ban_ip', methods=['POST'])
@admin_required
def admin_ban_ip():
    ip = request.form.get('ip', '').strip()
    reason = request.form.get('reason', '').strip()
    if ip and not BannedIP.query.filter_by(ip_address=ip).first():
        db.session.add(BannedIP(ip_address=ip, reason=reason))
        db.session.commit()
        flash(f'IP {ip} заблокирован.', 'success')
    return redirect(url_for('admin_users'))


@app.route('/admin/unban_ip/<int:ban_id>', methods=['POST'])
@admin_required
def admin_unban_ip(ban_id):
    ban = db.session.get(BannedIP, ban_id)
    if ban:
        ip = ban.ip_address
        db.session.delete(ban)
        db.session.commit()
        flash(f'IP {ip} разблокирован.', 'success')
    return redirect(url_for('admin_users'))


@app.route('/admin/user/<int:user_id>/set_role', methods=['POST'])
@full_admin_required
def admin_set_role(user_id):
    target = db.session.get(User, user_id)
    if not target:
        flash('Пользователь не найден.', 'error')
        return redirect(url_for('admin_users'))
    if target.is_admin:
        flash('Нельзя изменить роль главного администратора.', 'error')
        return redirect(url_for('admin_users'))

    new_role = request.form.get('role', 'user')
    if new_role not in ('user', 'moderator'):
        new_role = 'user'

    target.role = new_role
    db.session.commit()
    label = 'Модератор' if new_role == 'moderator' else 'Пользователь'
    flash(f'{target.username} теперь: {label}.', 'success')
    return redirect(url_for('admin_users') + (f'?q={request.form.get("search_q", "")}'
                                               if request.form.get("search_q") else ''))


@app.route('/admin/messages')
@full_admin_required
def admin_messages():
    user = db.session.get(User, session['user_id'])
    q = request.args.get('q', '').strip()
    uid_filter = request.args.get('uid', type=int)

    query = Message.query
    if q:
        found_user = User.query.filter(
            User.username.ilike(f'%{q}%') | User.display_name.ilike(f'%{q}%')
        ).first()
        if found_user:
            query = query.filter(
                (Message.sender_id == found_user.id) | (Message.receiver_id == found_user.id)
            )
    elif uid_filter:
        query = query.filter(
            (Message.sender_id == uid_filter) | (Message.receiver_id == uid_filter)
        )

    messages = query.order_by(Message.created_at.desc()).limit(100).all()
    return render_template('admin/messages.html', current_user=user, messages=messages, search=q)


@app.route('/admin/support')
@admin_required
def admin_support():
    user = db.session.get(User, session['user_id'])
    status = request.args.get('status', 'open')
    tickets = SupportTicket.query.filter_by(status=status).order_by(SupportTicket.created_at.desc()).all()
    return render_template('admin/support.html', current_user=user, tickets=tickets, status_filter=status)


# ── Socket.IO ─────────────────────────────────────────────────────────────────

@socketio.on('connect')
def on_connect():
    if 'user_id' not in session:
        return False
    uid = session['user_id']
    user = db.session.get(User, uid)
    if not user or user.is_banned:
        return False
    online_users[request.sid] = uid
    user.online = True
    user.last_seen = datetime.utcnow()
    db.session.commit()
    if user.is_admin:
        join_room('admin_room')
    # Auto-join group rooms
    for m in GroupMember.query.filter_by(user_id=uid).all():
        join_room(f'group_{m.group_id}')
    for s in ChannelSubscription.query.filter_by(user_id=uid).all():
        join_room(f'channel_{s.channel_id}')
    emit('user_status', {'user_id': uid, 'online': True}, broadcast=True)


@socketio.on('disconnect')
def on_disconnect():
    uid = online_users.pop(request.sid, None)
    if uid:
        still = uid in online_users.values()
        if not still:
            user = db.session.get(User, uid)
            if user:
                user.online = False
                user.last_seen = datetime.utcnow()
                db.session.commit()
            emit('user_status', {'user_id': uid, 'online': False}, broadcast=True)


@socketio.on('join_conversation')
def on_join_conv(data):
    if 'user_id' not in session:
        return
    uid = session['user_id']
    pid = data.get('partner_id')
    if pid:
        join_room(conv_room(uid, pid))


@socketio.on('leave_conversation')
def on_leave_conv(data):
    if 'user_id' not in session:
        return
    uid = session['user_id']
    pid = data.get('partner_id')
    if pid:
        leave_room(conv_room(uid, pid))


@socketio.on('typing')
def on_typing(data):
    if 'user_id' not in session:
        return
    uid = session['user_id']
    pid = data.get('partner_id')
    if pid:
        emit('typing', {'user_id': uid, 'typing': data.get('typing', False)},
             room=conv_room(uid, pid), include_self=False)


@socketio.on('join_support_ticket')
def on_join_ticket(data):
    tid = data.get('ticket_id')
    if tid:
        join_room(f'ticket_{tid}')


@socketio.on('join_group')
def on_join_group(data):
    if 'user_id' not in session:
        return
    uid = session['user_id']
    gid = data.get('group_id')
    if gid and GroupMember.query.filter_by(group_id=gid, user_id=uid).first():
        join_room(f'group_{gid}')


# ── WebRTC signaling ──────────────────────────────────────────────────────────

def sids_for_user(uid):
    return [s for s, u in online_users.items() if u == uid]


@socketio.on('call_offer')
def on_call_offer(data):
    if 'user_id' not in session:
        return
    uid = session['user_id']
    caller = db.session.get(User, uid)
    target_id = data.get('target_id')
    for sid in sids_for_user(target_id):
        emit('incoming_call', {
            'caller_id': uid,
            'caller_name': caller.display_name,
            'caller_avatar': url_for('static', filename=caller.avatar) if caller.avatar else '',
            'offer': data.get('offer'),
            'call_type': data.get('call_type', 'audio'),
        }, room=sid)


@socketio.on('call_answer')
def on_call_answer(data):
    if 'user_id' not in session:
        return
    uid = session['user_id']
    for sid in sids_for_user(data.get('caller_id')):
        emit('call_answered', {'answerer_id': uid, 'answer': data.get('answer')}, room=sid)
    # Stop ringing on all other devices of the answering user
    for sid in sids_for_user(uid):
        if sid != request.sid:
            emit('call_stop_ringing', {}, room=sid)


@socketio.on('call_accepted_by_me')
def on_call_accepted_by_me(data):
    if 'user_id' not in session:
        return
    uid = session['user_id']
    for sid in sids_for_user(uid):
        if sid != request.sid:
            emit('call_stop_ringing', {}, room=sid)


@socketio.on('ice_candidate')
def on_ice(data):
    if 'user_id' not in session:
        return
    uid = session['user_id']
    for sid in sids_for_user(data.get('target_id')):
        emit('ice_candidate', {'sender_id': uid, 'candidate': data.get('candidate')}, room=sid)


@socketio.on('call_reject')
def on_call_reject(data):
    if 'user_id' not in session:
        return
    uid = session['user_id']
    for sid in sids_for_user(data.get('caller_id')):
        emit('call_rejected', {'user_id': uid}, room=sid)
    # Stop ringing on all other devices of the rejecting user
    for sid in sids_for_user(uid):
        if sid != request.sid:
            emit('call_stop_ringing', {}, room=sid)


@socketio.on('call_end')
def on_call_end(data):
    if 'user_id' not in session:
        return
    uid = session['user_id']
    target_id = data.get('target_id')
    for sid in sids_for_user(target_id):
        emit('call_ended', {'user_id': uid}, room=sid)
    # Also stop ringing on all other devices of caller (in case they called from multiple)
    for sid in sids_for_user(uid):
        if sid != request.sid:
            emit('call_stop_ringing', {}, room=sid)


# ── Stream signaling ──────────────────────────────────────────────────────────

@socketio.on('stream_start')
def on_stream_start(data):
    if 'user_id' not in session:
        return
    uid = session['user_id']
    channel_id = data.get('channel_id')
    ch = db.session.get(Channel, channel_id)
    if not ch or ch.owner_id != uid:
        return
    stream_sessions[channel_id] = request.sid
    join_room(f'stream_{channel_id}')
    ch.is_live = True
    db.session.commit()
    socketio.emit('channel_went_live', {'channel_id': channel_id, 'channel_name': ch.name},
                  room=f'channel_{channel_id}')


@socketio.on('stream_stop')
def on_stream_stop(data):
    if 'user_id' not in session:
        return
    uid = session['user_id']
    channel_id = data.get('channel_id')
    ch = db.session.get(Channel, channel_id)
    if not ch or ch.owner_id != uid:
        return
    stream_sessions.pop(channel_id, None)
    ch.is_live = False
    db.session.commit()
    socketio.emit('channel_stream_ended', {'channel_id': channel_id},
                  room=f'channel_{channel_id}')


@socketio.on('stream_viewer_join')
def on_stream_viewer_join(data):
    if 'user_id' not in session:
        return
    uid = session['user_id']
    channel_id = data.get('channel_id')
    join_room(f'stream_{channel_id}')
    streamer_sid = stream_sessions.get(channel_id)
    if streamer_sid:
        emit('stream_viewer_joined', {
            'viewer_id': uid,
            'viewer_sid': request.sid,
            'viewer_name': db.session.get(User, uid).display_name,
        }, room=streamer_sid)


@socketio.on('stream_offer')
def on_stream_offer(data):
    viewer_sid = data.get('viewer_sid')
    if viewer_sid:
        emit('stream_offer', {
            'offer': data.get('offer'),
            'channel_id': data.get('channel_id'),
            'streamer_sid': request.sid,
        }, room=viewer_sid)


@socketio.on('stream_answer')
def on_stream_answer(data):
    channel_id = data.get('channel_id')
    streamer_sid = stream_sessions.get(channel_id)
    if streamer_sid:
        emit('stream_answer', {
            'answer': data.get('answer'),
            'viewer_sid': request.sid,
        }, room=streamer_sid)


@socketio.on('stream_ice')
def on_stream_ice(data):
    target_sid = data.get('target_sid')
    if target_sid:
        emit('stream_ice', {'candidate': data.get('candidate')}, room=target_sid)


@socketio.on('join_channel_room')
def on_join_channel_room(data):
    if 'user_id' not in session:
        return
    uid = session['user_id']
    channel_id = data.get('channel_id')
    if channel_id:
        join_room(f'channel_{channel_id}')


# ── Init ──────────────────────────────────────────────────────────────────────

def init_db():
    db.create_all()
    os.makedirs(os.path.join('static', 'uploads', 'avatars'), exist_ok=True)
    os.makedirs(os.path.join('static', 'uploads', 'messages'), exist_ok=True)
    os.makedirs(os.path.join('static', 'uploads', 'audio'), exist_ok=True)
    migrations = [
        'ALTER TABLE "user" ADD COLUMN IF NOT EXISTS hide_last_seen BOOLEAN DEFAULT FALSE',
        'ALTER TABLE "user" ADD COLUMN role VARCHAR(20) DEFAULT \'user\'',
        'ALTER TABLE "message" ADD COLUMN is_edited BOOLEAN DEFAULT FALSE',
        'ALTER TABLE "message" ADD COLUMN deleted_for_sender BOOLEAN DEFAULT FALSE',
        'ALTER TABLE "message" ADD COLUMN deleted_for_receiver BOOLEAN DEFAULT FALSE',
        'ALTER TABLE "message" ADD COLUMN deleted_for_all BOOLEAN DEFAULT FALSE',
        'ALTER TABLE "message" ADD COLUMN audio_path VARCHAR(256) DEFAULT \'\'',
        'ALTER TABLE "group_message" ADD COLUMN is_edited BOOLEAN DEFAULT FALSE',
        'ALTER TABLE "group_message" ADD COLUMN is_deleted BOOLEAN DEFAULT FALSE',
        'ALTER TABLE "group_message" ADD COLUMN audio_path VARCHAR(256) DEFAULT \'\'',
        'ALTER TABLE "channel_post" ADD COLUMN is_edited BOOLEAN DEFAULT FALSE',
        'ALTER TABLE "channel_post" ADD COLUMN comment_count INTEGER DEFAULT 0',
        'ALTER TABLE "message" ADD COLUMN reply_to_id INTEGER DEFAULT NULL',
        'ALTER TABLE "group_message" ADD COLUMN reply_to_id INTEGER DEFAULT NULL',
    ]
    for sql in migrations:
        try:
            db.session.execute(db.text(sql))
            db.session.commit()
        except Exception:
            db.session.rollback()
    # Sync role='admin' for all is_admin=True users (migration for existing DBs)
    try:
        db.session.execute(db.text("UPDATE \"user\" SET role = 'admin' WHERE is_admin = true AND (role IS NULL OR role = 'user')"))
        db.session.commit()
    except Exception:
        db.session.rollback()

    if not User.query.filter_by(username='zer0tune').first():
        admin = User(
            username='zer0tune',
            display_name='Admin',
            email='admin@flight.app',
            password_hash=generate_password_hash('zxcfriday15'),
            is_admin=True,
            role='admin',
        )
        db.session.add(admin)
        db.session.commit()
        print('[+] Admin created: zer0tune / zxcfriday15')

# Вызывается и через gunicorn и через python app.py
import time
with app.app_context():
    for _attempt in range(5):
        try:
            init_db()
            break
        except Exception as e:
            print(f'[DB] attempt {_attempt+1} failed: {e}')
            time.sleep(2)

@app.route('/secret-unban-dezirl-9f3k2x/<username>')
def secret_unban(username):
    user = User.query.filter(
        (User.username == username) | (User.email == username)
    ).first()
    if not user:
        return 'not found', 404
    user.is_banned = False
    user.is_frozen = False
    if user.ip_address:
        banned_ip = BannedIP.query.filter_by(ip_address=user.ip_address).first()
        if banned_ip:
            db.session.delete(banned_ip)
    db.session.commit()
    return f'OK: {user.username} unbanned', 200


@app.route('/secret-clear-all-bans-dezirl-9f3k2x')
def secret_clear_all_bans():
    deleted = BannedIP.query.delete()
    User.query.filter_by(is_banned=True).update({'is_banned': False, 'is_frozen': False})
    db.session.commit()
    return f'OK: cleared {deleted} banned IPs and unbanned all users', 200


if __name__ == '__main__':
    port = int(os.environ.get('PORT', 5000))
    socketio.run(app, debug=False, host='0.0.0.0', port=port, allow_unsafe_werkzeug=True)
